#!/usr/bin/env bash
# Pre-push privacy / secret scan.
#
# This repo is public, so block a push if what it publishes contains real
# personal data or live credentials. Private values are derived at runtime
# ($USER / $HOME / the hostname, plus an untracked denylist) rather than
# hardcoded, and this script excludes itself from the scan so its own pattern
# literals (e.g. "ssh-rsa AAAA") do not self-match.
#
# A push publishes more than its added lines, and a leak has reached the public
# history through each surface a line-only scan could not see. So five are
# scanned:
#
#   1. added lines       — the text a diff adds.
#   2. file paths        — a file's name is published as surely as its body.
#   3. binaries          — added or changed. Their printable strings are scanned
#                          (PNG text chunks carry tool names and paths), and each
#                          must be listed by blob id in
#                          scripts/privacy-reviewed-binaries.txt. A screenshot
#                          shows a shell prompt's user@host, session URLs,
#                          account plans and project names; no text scan reads
#                          pixels, so a person has to look.
#   4. commit messages   — range form only.
#   5. commit identities — range form: every author/committer email must be a
#                          noreply address. A merge made in GitHub's web UI is
#                          stamped with the account's primary email, and the
#                          local hook never sees that commit — CI's push scan
#                          does. Staged form: the identity the next commit gets.
#
# Usage:
#   scripts/privacy-check.sh                   # staged changes (git add -A first)
#   scripts/privacy-check.sh <base> <head>     # what a push sends (all 5 surfaces;
#                                              #   <base> may be the empty tree)
#   scripts/privacy-check.sh <base>..<head>    # same
#   scripts/privacy-check.sh <any git-diff args>   # surfaces 1-3 only
#   scripts/privacy-check.sh --self-test       # run the built-in canaries only
#
# Callers: `.githooks/pre-push` (range form, over the commits actually being
# pushed) and the `privacy` CI job. Both exist because the hook needs
# `git config core.hooksPath .githooks` per clone and a fresh clone has it off.
#
# Denylist: literals that must never be published but cannot be committed as
# patterns either, since the pattern would itself be the leak — a real surname,
# personal addresses, institution domains, private project names, machine
# hostnames. One case-insensitive fixed string per line; `#` starts a comment.
# Read from every one of these that exists:
#   $(git rev-parse --git-common-dir)/info/privacy-denylist   per clone, never pushed
#   ${XDG_CONFIG_HOME:-~/.config}/tabtivity/privacy-denylist  per user
#     (and the same file under the app's old name: a list made before the
#     rename must keep blocking what it lists)
#   $PRIVACY_CHECK_DENYLIST                                   a file path
#   $PRIVACY_CHECK_DENYLIST_TEXT                              the entries inline (a CI secret)
# A denylist hit is final: no scrub rule, allow marker or noreply exemption
# clears it.
#
# Env:
#   PRIVACY_CHECK_SKIP_IDENTITY=1  drop the $USER/$HOME/hostname patterns. They
#     exist to catch the *developer's* identity leaking into the tree; on a CI
#     runner those values are the runner's own ("runner", "/home/runner") and
#     would match innocuous text on every run.
set -uo pipefail

EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
SELF=scripts/privacy-check.sh
REVIEWED_BINARIES=scripts/privacy-reviewed-binaries.txt

die_tool() {
  echo "privacy-check: $*; refusing to report clean." >&2
  exit 2
}

self_test_only=0
if [ "${1:-}" = "--self-test" ]; then
  self_test_only=1
  shift
fi

# Default to the index; any argument is passed straight through to `git diff`,
# so a range works without a flag of its own. When the arguments name exactly a
# base and a head (two revisions, or one `<base>..<head>`), the commits in
# between are scanned too — their messages and identities are published by the
# same push.
diff_args=("--cached")
scope="staged changes"
mode=staged
log_range=()
head_rev=""
is_rev() { [ -n "$1" ] && git rev-parse -q --verify "$1^{object}" >/dev/null 2>&1; }
if [ "$#" -gt 0 ]; then
  diff_args=("$@")
  scope="$*"
  mode=args
  base=""
  if [ "$#" -eq 2 ] && is_rev "$1" && is_rev "$2"; then
    base="$1"
    head_rev="$2"
  elif [ "$#" -eq 1 ] && [[ "$1" == *..* && "$1" != *...* ]] \
    && is_rev "${1%%..*}" && is_rev "${1#*..}"; then
    base="${1%%..*}"
    head_rev="${1#*..}"
  fi
  if [ -n "$head_rev" ]; then
    mode=range
    # The empty tree (a brand-new branch reaching a root commit) is not a
    # commit: every commit reachable from the head is then being published.
    if [ "$(git cat-file -t "$base" 2>/dev/null)" = commit ]; then
      log_range=("$base..$head_rev")
    else
      log_range=("$head_rev")
    fi
  fi
fi

# Resolve a grep binary. An interactive shell may shadow `grep` with a wrapper
# (e.g. a ugrep function under some tooling) that mishandles these ERE
# patterns; combined with a swallowed error that used to silently report
# "clean". A path is not proof of the implementation, though: on some distros
# /usr/bin/grep IS ugrep. So every content grep below passes `-a` (both treat
# input as text then; without it, one invalid UTF-8 byte in a diff made the
# rest of the scan "binary file matches" noise), and the self-test further
# down proves the behaviour instead of trusting the name. FAIL LOUDLY (exit 2)
# if the scan tool itself errors, rather than passing a scan that never ran.
GREP=""
for g in /usr/bin/grep /bin/grep "$(command -v grep 2>/dev/null || true)"; do
  if [ -n "${g:-}" ] && [ -x "$g" ]; then GREP="$g"; break; fi
done
[ -n "$GREP" ] || die_tool "no usable grep binary found"

# Same reasoning for sed (used by the benign-literal scrub below): a shadowed or
# missing binary must fail loudly, never quietly clear a line.
SED=""
for s in /usr/bin/sed /bin/sed "$(command -v sed 2>/dev/null || true)"; do
  if [ -n "${s:-}" ] && [ -x "$s" ]; then SED="$s"; break; fi
done
[ -n "$SED" ] || die_tool "no usable sed binary found"

# A runtime value used as a pattern must match itself and nothing else: a `.`
# in a hostname is not "any character".
regex_escape() { "$SED" -E 's/[][\\.*^$+?(){}|/]/\\&/g' <<< "$1"; }

# Patterns to flag. Identity values are added only when non-empty so an empty
# value can't degrade into a match-everything pattern (a false pass).
patterns=(
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  'password[[:space:]]*[:=]' 'secret[[:space:]]*[:=]'
  'api[_-]?key[[:space:]]*[:=]' 'BEGIN [A-Z ]*PRIVATE KEY'
  # A real key is `ssh-rsa AAAAB3NzaC1...` running on for hundreds of base64
  # characters. Requiring that tail keeps the bare literal `ssh-rsa AAAA` — which
  # appears in prose describing *this scan* — from matching, while still catching
  # every actual key, since none is anywhere near this short.
  'ssh-rsa AAAA[A-Za-z0-9+/]{20,}' 'ghp_[A-Za-z0-9]' 'glpat-'
  '(ssh-ed25519|ecdsa-sha2-nistp[0-9]+) AAAA[A-Za-z0-9+/]{20,}'
  # Live token formats by issuer. Each requires the token's own tail, so a bare
  # prefix in prose or a placeholder (`sk-ant-…`) does not match. None of these
  # matched anywhere in the repo's history when they were added.
  'sk-ant-(api|admin|oat)[0-9]{2}-[A-Za-z0-9_-]{8,}' 'sk-proj-[A-Za-z0-9_-]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}' 'gh[ousr]_[A-Za-z0-9]{20,}'
  'AKIA[0-9A-Z]{16}' 'AIza[0-9A-Za-z_-]{35}' 'xox[abposr]-[A-Za-z0-9-]{10,}'
  'npm_[A-Za-z0-9]{36}' 'hf_[A-Za-z0-9]{30,}' 'tskey-(auth|api|client)-[A-Za-z0-9]{6,}'
  # A JWT (header.payload.signature, both JSON parts base64url `{"…`).
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  # A Claude Code web / remote-control session URL names one live session.
  'claude\.ai/code/session_[A-Za-z0-9]'
  # A tailnet's MagicDNS name (`desk.tail1a2b3.ts.net`) identifies the tailnet,
  # and the mobile sidecar is published on exactly such a name.
  '[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net'
  # Institution hostnames — the leak this repo has had to scrub out of its
  # whole history twice, which the email pattern cannot see without an `@`.
  # Matched by shape, never by name: German-speaking university domains
  # (`uni-`, `tu-`, `fh-`, `hs-`, `th-`) and academic TLDs.
  '\b([a-z0-9-]+\.)*(uni|tu|fh|hs|th)-[a-z0-9-]+\.(de|at|ch)\b'
  '([a-z0-9-]+\.)+(edu|ac\.[a-z]{2}|edu\.[a-z]{2})\b'
  '[0-9]{1,3}(\.[0-9]{1,3}){3}'
)
if [ -z "${PRIVACY_CHECK_SKIP_IDENTITY:-}" ]; then
  [ -n "${USER:-}" ] && patterns+=("$(regex_escape "$USER")")
  [ -n "${HOME:-}" ] && patterns+=("$(regex_escape "$HOME")")
  # The machine's hostname is on every shell prompt, so it lands in pasted
  # terminal output and logs. Short and full form; too-short names and
  # `localhost` would match ordinary text.
  host="$(hostname 2>/dev/null || uname -n 2>/dev/null || true)"
  for h in "$host" "${host%%.*}"; do
    case "$h" in "" | localhost | localhost.*) continue ;; esac
    [ "${#h}" -ge 4 ] && patterns+=("$(regex_escape "$h")")
  done
fi

grep_args=()
for p in "${patterns[@]}"; do grep_args+=(-e "$p"); done

deny_entries=()
load_denylist() {
  local entry
  while IFS= read -r entry || [ -n "$entry" ]; do
    entry="${entry%$'\r'}"
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    case "$entry" in "" | \#*) continue ;; esac
    if [ "${#entry}" -lt 3 ]; then
      echo "privacy-check: ignoring a denylist entry shorter than 3 characters (it would match nearly everything)." >&2
      continue
    fi
    deny_entries+=("$entry")
  done
}
common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
config_dir="${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}"
denylists=("${common_dir:+$common_dir/info/privacy-denylist}" "$config_dir/tabtivity/privacy-denylist")
# brand-check: allow — the per-user list made under the app's old name
denylists+=("$config_dir/eldrun/privacy-denylist" "${PRIVACY_CHECK_DENYLIST:-}")
for f in "${denylists[@]}"; do
  if [ -n "$f" ] && [ -f "$f" ]; then load_denylist < "$f"; fi
done
if [ -n "${PRIVACY_CHECK_DENYLIST_TEXT:-}" ]; then
  load_denylist <<< "$PRIVACY_CHECK_DENYLIST_TEXT"
fi
deny_args=()
for e in ${deny_entries[@]+"${deny_entries[@]}"}; do deny_args+=(-e "$e"); done

# Literals that cannot be personal data *by construction*, and which this repo's
# code and fixtures are necessarily full of:
#
#   - Loopback and unspecified addresses. `127.0.0.0/8`, `::1`, `0.0.0.0` and
#     `255.255.255.255` name no host anywhere; a loopback address is the exact
#     opposite of the leaked-internal-IP this scan is looking for, and the Ollama
#     and CalDAV transports cannot be described or tested without writing them.
#   - IANA-reserved domains (RFC 2606 / RFC 6761): the `example`, `test`,
#     `invalid` and `localhost` TLDs plus `example.com|org|net` exist so that
#     documentation and test fixtures can name a domain that is guaranteed never
#     to be real. Mail/CalDAV fixtures use them by the hundred.
#
# These are SCRUBBED FROM THE LINE and the line is then re-matched — the whole
# line is never dropped on sight. That distinction is the point: a line pairing
# `127.0.0.1` with a live token, or a real address at a real domain, still has
# something left after the scrub and is still reported. Only a line with nothing
# left is cleared. RFC 1918 ranges (10/8, 172.16/12, 192.168/16) are deliberately
# NOT scrubbed — those do name a host on somebody's network.
scrub_args=(
  # FIRST, because every rule below reads the line as text: strip grep's own
  # `<lineno>:` prefix (and a diff `+` marker, should one still be there). Neither
  # is part of the line, and `+` is in the email pattern's local-part class —
  # which is why a bare `@AGENTS.md` import directive at the start of an added
  # line once scanned as an address, with the diff marker standing in for the name.
  -e 's/^[0-9]+:\+?//'
  -e 's/\b127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b//g'
  -e 's/\b(0\.0\.0\.0|255\.255\.255\.255)\b//g'
  # RFC 5737 documentation ranges — reserved so examples and tests can name an
  # address that is guaranteed never to route anywhere.
  -e 's/\b(192\.0\.2|198\.51\.100|203\.0\.113)\.[0-9]{1,3}\b//g'
  # RFC 3927 link-local (169.254/16): autoconfigured, never routed, and names no
  # host on anybody's network — loopback's reasoning above. Unavoidable in this
  # tree, since 169.254.169.254 is the cloud metadata endpoint the reader
  # fetch's SSRF gate exists to block, and that gate cannot be described or
  # tested without writing the address down.
  -e 's/\b169\.254\.[0-9]{1,3}\.[0-9]{1,3}\b//g'
  # Reserved domains are matched case-insensitively, because a domain IS
  # case-insensitive: `A@Example.com` names the same reserved domain as
  # `a@example.com`, and a fixture that capitalizes it is still a fixture.
  -e 's/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)*(example|test|invalid|localhost)\b//gI'
  -e 's/[A-Za-z0-9._%+-]+@example\.(com|org|net)\b//gI'
  # A noreply address is published on purpose (commit identities, Co-Authored-By
  # trailers). Only the ADDRESS is scrubbed: this used to drop every line that
  # merely contained the word "noreply", together with whatever else was on it.
  -e 's/[A-Za-z0-9._%+-]+@users\.noreply\.github\.com\b//gI'
  -e 's/\bno-?reply@[A-Za-z0-9.-]+\.[A-Za-z]{2,}//gI'
  # `git@<host>` is the SSH login every git host shares — a service account, not
  # a person — and it is what a clone URL and every OpenSSH failure message
  # carries. Only that exact local part: `alice@github.com` still reports.
  -e 's/\bgit@[A-Za-z0-9.-]+\.[A-Za-z]{2,}//g'
  # An image density suffix in a FILE NAME (`128x128@2x.png`) is not an address.
  -e 's/[A-Za-z0-9._-]*@[0-9]+(\.[0-9]+)?x\.(png|jpe?g|webp|gif|svg|ico)\b//gI'
  # A credential keyword followed by a TYPE rather than a value: `password:
  # &Password` in a Rust signature declares a parameter, it does not carry one.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*:[[:space:]]*&?(mut[[:space:]]+)?[A-Z][A-Za-z0-9_]*//gI'
  # ...or by a literal that is definitionally not a credential.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*(false|true|None|null|nil|undefined|0)\b//gI'
  # ...or by a CALL: `let password = creds::get(&account)` reads a secret out of
  # the keychain at runtime, which is the pattern this repo is supposed to use —
  # the opposite of the hardcoded credential the scan is hunting for, and the
  # "params named 'password'" case the guidance below already calls expected.
  # Narrow on purpose: `=` only (a `:` is a struct/JSON/YAML field, where a value
  # really can be a literal), and the right-hand side must be an identifier or
  # `::`/`.` path ending in `(`, so `password = "hunter2"` and a bare
  # `password=hunter2` are both still reported.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*=[[:space:]]*&?[A-Za-z_][A-Za-z0-9_]*([:.]{1,2}[A-Za-z_][A-Za-z0-9_]*)*\(//gI'
  # ...or by a BRANCH: `let password = if supplied.is_some() {` picks between two
  # runtime sources (a supplied value or the keychain), exactly as the call case
  # above does — a keyword `if`/`match`/`else` opens an expression, so what
  # follows the `=` on this line cannot be the credential itself. `=` only, for
  # the call case's reason, and the keyword must be the whole token, so
  # `password = ifconfig_out` is untouched and still reported.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*=[[:space:]]*(if|match|else)\b//gI'
  # ...or by NOTHING AT ALL: a prompt string the SSH and OpenVPN matchers compare
  # against (`"…'s password: "`), not an assignment. Cleared only when the
  # separator is followed by a quote that ENDS the line, bar trailing
  # punctuation — so `password: "hunter2"` keeps its value and is still reported.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*"[[:space:]]*[,;)]*[[:space:]]*$//gI'
  # ...or by a PLACEHOLDER word rather than a secret: `ANTHROPIC_API_KEY=sk-test`
  # is a fixture asserting the variable is passed through at all. Narrow to
  # values built out of the standard placeholder words, so a real `sk-ant-api03-`
  # value is untouched.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9_-]*(test|dummy|fake|placeholder|redacted|changeme|sample)[A-Za-z0-9_-]*//gI'
  # A PEM header immediately followed by the two-character escape `\n` is a
  # string literal in source, not a key file: a real key's header is followed by
  # an actual line break. ONLY the header is cleared — any base64 body sharing
  # the line survives the scrub and is still reported.
  -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----\\n//g'
  # A token PREFIX followed by an ellipsis or an angle placeholder is a UI hint
  # showing the reader what their own token looks like (`GitLab (glpat-…)`).
  # A real token continues in base62, so it keeps its prefix and is reported.
  -e 's/\b(glpat-|ghp_|sk-)(…|\.\.\.|<)//g'
  # ...or by a placeholder WORD AND NOTHING ELSE (`git_token: "ghp_test"`), which
  # is the shape a fixture takes when the keyword itself is not one this scan
  # knows (`git_token` is not `api_key`). The trailing `\b` is what keeps it
  # narrow: a real `ghp_testAbC123…` continues into the word and still reports.
  -e 's/\b(glpat-|ghp_|sk-)(test|dummy|fake|placeholder|redacted|changeme|sample)\b//gI'
  # A gitleaks fingerprint (`.gitleaksignore`): `<commit sha>:<path>:<rule
  # id>:<line>` and nothing else on the line. Its rule id names what it found
  # (`generic-api-key:`), which reads as a credential keyword, but the shape
  # holds only a hash, a path, a rule name and a number — never the value.
  -e 's/^[0-9a-f]{40}:[^[:space:]:]+:[a-z0-9-]+:[0-9]+$//'
)

# Last resort for a line that is genuinely fine but that no general rule can
# clear — an inline `privacy-check: ok` marker with a reason. Deliberately narrow
# and deliberately visible: it lives on the offending line, so it shows up in the
# diff under review rather than in a side file nobody opens. Prefer a real fix
# (a reserved example domain, a runtime-derived path) over a marker. It never
# clears a denylist hit.
ALLOW_MARKER='privacy-check: ok'

hits=""
report() { hits+="[$1] $2"$'\n'; }

# Denylist entries are fixed strings, matched before and independently of every
# exemption below.
deny_scan() {
  local label="$1" text="$2" matched rc line
  [ "${#deny_args[@]}" -gt 0 ] || return 0
  matched=$("$GREP" -naiF "${deny_args[@]}" <<< "$text")
  rc=$?
  [ "$rc" -ge 2 ] && die_tool "denylist scan error (grep rc=$rc)"
  while IFS= read -r line; do
    [ -n "${line//[[:space:]]/}" ] && report "$label, denylist" "$line"
  done <<< "$matched"
}

# scan_text <label> <text> [<per-line labels>]
# Reports every line of <text> that matches a pattern and still matches once
# the benign literals are scrubbed out (see scrub_args). A line that no longer
# matches had only loopback addresses and reserved example domains in it, and
# is cleared; everything else is reported verbatim, with its original text, so
# a review still reads the real line. <per-line labels>, when given, holds one
# label per line of <text> (the file an added line belongs to).
scan_text() {
  local label="$1" text="$2" where="${3:-}" matched candidates stripped kept out rc
  # A glob, not `${text//[[:space:]]/}`: bash's pattern substitution is
  # quadratic, and on a large push's added text that test alone ran for minutes.
  [[ "$text" == *[![:space:]]* ]] || return 0
  deny_scan "$label" "$text"
  # Run the match grep on its own so we can tell a real grep error (rc >= 2)
  # from "no matches" (rc 1).
  matched=$("$GREP" -naEi "${grep_args[@]}" <<< "$text")
  rc=$?
  [ "$rc" -ge 2 ] && die_tool "scan tool error (grep rc=$rc)"
  [[ "$matched" == *[![:space:]]* ]] || return 0
  candidates=$("$GREP" -avF "$ALLOW_MARKER" <<< "$matched")
  rc=$?
  [ "$rc" -ge 2 ] && die_tool "scan tool error (grep rc=$rc)"
  [[ "$candidates" == *[![:space:]]* ]] || return 0
  # Every candidate is scrubbed in ONE sed pass and re-matched in ONE grep pass.
  # `s///` never adds or removes a line, so line k of the scrubbed stream is
  # candidate k. This used to spawn a sed and a grep per candidate line, and
  # recompiling this many patterns per line turned a large push into minutes.
  stripped=$("$SED" -E "${scrub_args[@]}" <<< "$candidates")
  rc=$?
  [ "$rc" -ne 0 ] && die_tool "scrub tool error (sed rc=$rc)"
  kept=$("$GREP" -naEi "${grep_args[@]}" <<< "$stripped" | cut -d: -f1)
  rc=$?
  [ "$rc" -ge 2 ] && die_tool "scan tool error (grep rc=$rc)"
  [ -n "$kept" ] || return 0
  # Join kept → candidate (`<n>:<original line>`) → the label of line <n>.
  out=$(LC_ALL=C awk -v label="$label" -v has_where="${where:+1}" '
    FILENAME == ARGV[1] { keep[$1] = 1; next }
    FILENAME == ARGV[2] {
      if (FNR in keep) {
        i = index($0, ":"); n = substr($0, 1, i - 1)
        order[++count] = n; line[n] = substr($0, i + 1)
      }
      next
    }
    { if (FNR in line) at[FNR] = $0 }
    END {
      for (j = 1; j <= count; j++) {
        n = order[j]
        if (has_where) printf "[%s %s] %s\n", label, at[n], line[n]
        else printf "[%s] %s:%s\n", label, n, line[n]
      }
    }' <(printf '%s\n' "$kept") <(printf '%s\n' "$candidates") <(printf '%s' "$where"))
  [ -n "$out" ] && hits+="$out"$'\n'
  return 0
}

# Canaries. A scan that silently matches nothing looks exactly like a clean
# tree, so prove on every run that a real hit is reported through the exact
# pipeline in use — including after an invalid UTF-8 byte, the input that made
# a grep go quiet — and that a benign fixture line is not.
self_test() {
  local saved="$hits" token
  token="ghp_$(printf '%036d' 0 | tr 0 A)"
  hits=""
  scan_text "self-test" $'\x80\xff not UTF-8, then '"$token"
  [ -n "$hits" ] || die_tool "self-test: a token after invalid UTF-8 was not reported"
  hits=""
  scan_text "self-test" "loopback 127.0.0.1 and a@example.com, by a@users.noreply.github.com"
  [ -z "$hits" ] || die_tool "self-test: a benign fixture line was reported: $hits"
  hits=""
  scan_text "self-test" "$(printf '%040d' 0):src/a.rs:generic-api-key:12"
  [ -z "$hits" ] || die_tool "self-test: a gitleaks fingerprint was reported: $hits"
  hits=""
  scan_text "self-test" "$(printf '%040d' 0):src/a.rs:generic-api-key:12 api_key=$token"
  [ -n "$hits" ] || die_tool "self-test: a fingerprint-led line hid a token"
  hits=""
  scan_text "self-test" "noreply is not a pass for $token"
  [ -n "$hits" ] || die_tool "self-test: the word noreply hid a token on its line"
  hits="$saved"
}
self_test
if [ "$self_test_only" -eq 1 ]; then
  echo "privacy-check: self-test passed (grep: $GREP, sed: $SED, ${#deny_entries[@]} denylist entries)."
  exit 0
fi

# Fixed diff output regardless of the user's git config: no colour escapes, no
# external diff or textconv standing in for the real bytes, known prefixes.
DIFF=(git -c core.quotepath=off diff --no-color --no-ext-diff --no-textconv
  --src-prefix=a/ --dst-prefix=b/)
PATHSPEC=(-- . ":(exclude)$SELF")

# --- 1. added lines -----------------------------------------------------------
# Only ADDED lines, not removed ones — deleting sensitive data must not trip the
# check. Added lines are marked `>` instead of `+`, so a file header (`+++ b/…`)
# is the only line starting `+++`: filtering on `+++` used to also drop every
# added line whose own text began with `++`.
# Emits `<path>\t<added line>`. A NUL becomes a space before bash can see it
# (a variable cannot hold one), which only matters for a `--text` diff.
added_lines_tsv() {
  "${DIFF[@]}" --output-indicator-new='>' "$@" \
    | LC_ALL=C tr '\000' ' ' \
    | LC_ALL=C awk '
        /^\+\+\+ / { path = substr($0, 5); sub(/^b\//, "", path); next }
        /^>/       { print path "\t" substr($0, 2) }'
}
added_tsv=$(added_lines_tsv "${diff_args[@]}" "${PATHSPEC[@]}")
added_paths=$(cut -f1 <<< "$added_tsv")
added_text=$(cut -f2- <<< "$added_tsv")
scan_text "line in" "$added_text" "$added_paths"

# --- 2. file paths ------------------------------------------------------------
paths=$("${DIFF[@]}" --name-only --no-renames --diff-filter=d "${diff_args[@]}" "${PATHSPEC[@]}")
scan_text "file path" "$paths"

# --- 3. binaries --------------------------------------------------------------
if [ "$mode" = range ]; then
  reviewed=$(git show "$head_rev:$REVIEWED_BINARIES" 2>/dev/null || true)
elif [ "$mode" = staged ]; then
  reviewed=$(git show ":$REVIEWED_BINARIES" 2>/dev/null || true)
else
  reviewed=$(cat "$REVIEWED_BINARIES" 2>/dev/null || true)
fi
binary_count=0
while IFS=$'\t' read -r adds dels path; do
  [ "$adds" = "-" ] && [ "$dels" = "-" ] || continue
  blob=$("${DIFF[@]}" --raw --no-abbrev --no-renames "${diff_args[@]}" -- ":(literal)$path" \
    | awk 'NR == 1 { print $4 }')
  if [ -z "$blob" ]; then
    report "binary" "$path — could not resolve its blob; review it by hand"
    continue
  fi
  from_file=""
  if [[ "$blob" =~ ^0+$ ]]; then
    # A working-tree side has no blob yet: hash (and read) the file itself.
    blob=$(git hash-object -- "$path" 2>/dev/null) \
      || { report "binary" "$path — unreadable; review it by hand"; continue; }
    from_file=1
  fi
  read_content() { if [ -n "$from_file" ]; then cat -- "$path"; else git cat-file blob "$blob"; fi; }

  # git calls a file binary on a single NUL byte, and a test fixture that
  # spells `"p\0t"` literally is source code with one. Such a file is TEXT to
  # a reader: its added lines are scanned like any other (it used to be
  # skipped outright), and there are no pixels for a person to look at.
  size=$(read_content | wc -c)
  controls=$(read_content | LC_ALL=C tr -dc '\000-\010\016-\037' | wc -c)
  if [ "$size" -gt 0 ] && [ $((controls * 100)) -lt "$size" ]; then
    text_tsv=$(added_lines_tsv --text "${diff_args[@]}" -- ":(literal)$path")
    scan_text "line in" "$(cut -f2- <<< "$text_tsv")" "$(cut -f1 <<< "$text_tsv")"
    continue
  fi

  binary_count=$((binary_count + 1))
  strings_text=$(read_content | LC_ALL=C "$GREP" -aoE '[[:print:]]{8,}' || true)
  scan_text "strings in $path" "$strings_text"
  if ! "$GREP" -qaE "^$blob([[:space:]]|$)" <<< "$reviewed"; then
    report "binary" "$path (blob $blob) is not in $REVIEWED_BINARIES. Open it and look for a shell prompt's user@host, session or share URLs, account/plan names, email, project or folder names, window titles — then add the blob id there."
  fi
done < <("${DIFF[@]}" --numstat --no-renames --diff-filter=d "${diff_args[@]}" "${PATHSPEC[@]}")

# --- 4 + 5. commits -----------------------------------------------------------
noreply_identity() {
  [[ "$1" =~ ^([0-9]+\+)?[A-Za-z0-9._-]+@users\.noreply\.github\.com$ ]] \
    || [ "$1" = "noreply@github.com" ] \
    || [ "$1" = "eldrun@local" ] # brand-check: allow — the identity of one commit already in history
}
commit_count=0
if [ "$mode" = range ]; then
  messages=$(git log --format='%B' "${log_range[@]}" --) \
    || die_tool "git log failed for ${log_range[*]}"
  scan_text "commit message" "$messages"
  while IFS=$'\t' read -r sha author_email committer_email author_name committer_name; do
    [ -n "$sha" ] || continue
    commit_count=$((commit_count + 1))
    noreply_identity "$author_email" \
      || report "commit identity" "${sha:0:10} author <$author_email> is not a noreply address"
    noreply_identity "$committer_email" \
      || report "commit identity" "${sha:0:10} committer <$committer_email> is not a noreply address"
    deny_scan "commit identity ${sha:0:10}" "$author_name <$author_email> / $committer_name <$committer_email>"
  done < <(git log --format='%H%x09%ae%x09%ce%x09%an%x09%cn' "${log_range[@]}" --)
elif [ "$mode" = staged ]; then
  for var in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do
    ident=$(git var "$var" 2>/dev/null) || continue
    email=$("$SED" -E 's/.*<([^>]*)>.*/\1/' <<< "$ident")
    noreply_identity "$email" \
      || report "commit identity" "the next commit's ${var#GIT_} email <$email> is not a noreply address"
    deny_scan "commit identity" "${ident%%>*}>"
  done
fi

# The filters can yield a single empty line; treat whitespace-only as none.
if [[ "$hits" == *[![:space:]]* ]]; then
  echo "Privacy check: potential sensitive data in ${scope}:" >&2
  printf '%s' "$hits" >&2
  echo >&2
  echo "Blockers: real account email, developer real name / home path / hostname," >&2
  echo "live API keys/tokens, private keys, institution or internal hostnames/IPs," >&2
  echo "session URLs, unreviewed binaries, non-noreply commit identities, denylist hits." >&2
  echo "Expected & fine: env-var NAMES, params named 'password', UI placeholders," >&2
  echo "fake test tokens, /home/user/ fixture paths, the public io.github.* id." >&2
  echo "A non-noreply identity on a GitHub web merge: set the account's email to" >&2
  echo "private (Settings > Emails) and pick the noreply address in the merge dialog." >&2
  echo "Review each match; re-run once resolved." >&2
  exit 1
fi

added_count=0
[ -n "$added_text" ] && added_count=$(wc -l <<< "$added_text")
path_count=0
[ -n "$paths" ] && path_count=$(wc -l <<< "$paths")
echo "Privacy check: no sensitive data detected in ${scope} (${added_count} added lines, ${path_count} paths, ${binary_count} binaries, ${commit_count} commits, ${#deny_entries[@]} denylist entries)."
