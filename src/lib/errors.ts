import { BRAND } from "./brand";
import type { TranslationKey } from "./i18n";

/**
 * Plain-language summaries for the raw error text the backend hands the UI —
 * an `io::Error`, ssh's stderr, git's refusal, a reqwest failure. The raw text
 * is kept (`ErrorNote` shows it under "Details"); this only puts a sentence a
 * user can act on in front of it.
 *
 * Order matters: the first matching rule wins, so a specific cause sits above
 * the generic one it would also match ("Permission denied (publickey)" is an
 * SSH login problem, not a file permission; a stale backend's "command … not
 * found" is not a missing program). Anything no rule knows comes back null and
 * is shown exactly as before — an unknown error is never hidden behind a vague
 * "something went wrong".
 *
 * Rules match technical wording only (OS error numbers, errno names, tool
 * output), so an already-translated sentence set as the error passes through.
 */
const RULES: { test: RegExp; key: TranslationKey }[] = [
  // The backend's refusal for a project with no local copy (`{UPPER}_REMOTE_ONLY:
  // <what>`, `remoteOnlyRefusal` in `lib/projectTabHost.ts`): its English tail
  // is never the summary, wherever the error surfaces.
  { test: new RegExp(`\\b${BRAND.upper}_REMOTE_ONLY:`), key: "tabs.remoteOnlyRefused" },
  { test: /\bcaldav_http_refused\b/, key: "caldav.httpRefused" },
  { test: /\bcommand [\w:.-]+ not found\b/i, key: "errors.backendOutdated" },
  { test: /Permission denied \((publickey|password|keyboard-interactive|gssapi)/i, key: "errors.sshAuth" },
  { test: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i, key: "errors.sshHostKey" },
  { test: /Could not resolve hostname|Name or service not known|Temporary failure in name resolution|failed to lookup address|dns error|nodename nor servname/i, key: "errors.dns" },
  { test: /Connection refused|os error 111\b|ECONNREFUSED|os error 10061\b/i, key: "errors.refused" },
  { test: /Network is unreachable|No route to host|os error 10[13]\b|os error 113\b|ENETUNREACH|EHOSTUNREACH/i, key: "errors.unreachable" },
  { test: /timed out|os error 110\b|ETIMEDOUT|os error 10060\b/i, key: "errors.timeout" },
  { test: /Connection reset|Connection closed by|Broken pipe|os error 104\b|os error 32\b|ECONNRESET|EPIPE/i, key: "errors.connectionLost" },
  { test: /certificate verify failed|invalid peer certificate|UnknownIssuer|self[- ]signed certificate/i, key: "errors.certificate" },
  { test: /\b429 Too Many Requests|rate limit exceeded/i, key: "errors.rateLimited" },
  { test: /error sending request|error trying to connect/i, key: "errors.network" },
  { test: /Cannot connect to the Docker daemon|docker daemon is not running/i, key: "errors.dockerDown" },
  { test: /locked collection|keyring is locked|org\.freedesktop\.secrets was not provided/i, key: "errors.keyringLocked" },
  { test: /not a git repository/i, key: "errors.notGitRepo" },
  { test: /\[rejected\]|non-fast-forward|Updates were rejected/i, key: "errors.pushRejected" },
  { test: /would be overwritten by (merge|checkout)|Please commit your changes or stash them/i, key: "errors.localChanges" },
  { test: /CONFLICT \(|Automatic merge failed|you have unmerged files/i, key: "errors.mergeConflict" },
  { test: /Authentication failed|could not read Username|401 Unauthorized/i, key: "errors.authFailed" },
  { test: /: command not found|is not recognized as an internal or external command/i, key: "errors.programMissing" },
  { test: /No space left on device|os error 28\b|ENOSPC|Disk quota exceeded|os error 122\b/i, key: "errors.diskFull" },
  { test: /Permission denied|os error 13\b|EACCES|Operation not permitted|os error 1\b|EPERM|Access is denied/i, key: "errors.permission" },
  { test: /File exists|os error 17\b|EEXIST/i, key: "errors.exists" },
  { test: /No such file or directory|os error 2\b|ENOENT|cannot find the (file|path) specified/i, key: "errors.notFound" },
];

export interface FriendlyError {
  /** One sentence saying what went wrong and what to try. */
  summary: string;
  /** The original text, unchanged, for the Details disclosure. */
  detail: string;
}

/** The plain-language summary for `raw`, or null when no rule knows it. */
export function friendlyError(
  raw: string,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): FriendlyError | null {
  const rule = RULES.find((r) => r.test.test(raw));
  return rule ? { summary: t(rule.key), detail: raw } : null;
}
