"""Antigravity's conversation store, read the way the phone Chat reads it.

    python3 -I scripts/verify-cli/antigravity/store.py <label> [<label> ...]

Reads `tmp/verify-cli/antigravity/<label>/h-main` (run main.py first): both
databases' schemas, the main conversations in `conversation_summaries.db`,
and each conversation's finished prompts and answers, decoded with the
fields `services::google_chat` takes — user input (type 14) field 19 → 2,
answer (type 15) field 20 → 1, created_at field 5 → 1, status 3. With two
labels, the statements that differ from the first label's are printed.
1.5.6 added `conversation_parents`, the search index's companion table (the
binary joins it to `conversations_fts`); the reader's `parent_conversation_id`
column stayed. Read-only: the databases open with `mode=ro`.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

USER, ANSWER, DONE = 14, 15, 3


def varint(b, i):
    n = shift = 0
    while True:
        c = b[i]
        i += 1
        n |= (c & 0x7F) << shift
        shift += 7
        if not c & 0x80:
            return n, i


def field(b, wanted):
    """The first `wanted` field: (wire type, bytes or int), or None."""
    i = 0
    try:
        while i < len(b):
            key, i = varint(b, i)
            num, wire = key >> 3, key & 7
            if wire == 0:
                v, i = varint(b, i)
            elif wire == 1:
                v, i = b[i:i + 8], i + 8
            elif wire == 2:
                n, i = varint(b, i)
                v, i = b[i:i + n], i + n
            elif wire == 5:
                v, i = b[i:i + 4], i + 4
            else:
                return None
            if num == wanted:
                return wire, v
    except IndexError:
        return None
    return None


def path(b, *nums):
    for n in nums:
        f = field(b, n)
        if f is None:
            return None
        b = f[1]
    return b


def connect(p):
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True)


def schema(p):
    with connect(p) as c:
        return sorted(r[0] for r in c.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL"))


def read(label):
    store = os.path.join(common.OUT, "antigravity", label, "h-main", ".gemini", "antigravity-cli")
    summaries = os.path.join(store, "conversation_summaries.db")
    conv = os.path.join(store, "conversations")
    out = {"summaries": schema(summaries), "steps": None, "chats": {}}
    with connect(summaries) as c:
        mains = c.execute("SELECT conversation_id, workspace_uris FROM conversation_summaries "
                          "WHERE parent_conversation_id = '' ORDER BY last_modified_time DESC").fetchall()
    for cid, uris in mains:
        db = os.path.join(conv, f"{cid}.db")
        if not os.path.exists(db):
            out["chats"][cid] = f"missing {cid}.db (workspace {uris})"
            continue
        out["steps"] = schema(db)
        with connect(db) as c:
            rows = c.execute("SELECT step_type, status, step_payload FROM steps WHERE step_type IN (?, ?) ORDER BY idx",
                             (USER, ANSWER)).fetchall()
        turns = []
        for kind, status, payload in rows:
            text = path(payload, 19, 2) if kind == USER else path(payload, 20, 1)
            at = field(path(payload, 5) or b"", 1)
            turns.append((kind, status, text.decode("utf-8", "replace")[:60] if text else None,
                          "time" if at else "no time"))
        out["chats"][cid] = {"workspace": uris, "turns": turns}
    return out


reads = {label: read(label) for label in sys.argv[1:]}
for label, r in reads.items():
    print(f"== {label}")
    for cid, chat in r["chats"].items():
        print(" ", cid, chat if isinstance(chat, str) else chat["workspace"])
        if isinstance(chat, dict):
            for kind, status, text, at in chat["turns"]:
                tag = "prompt" if kind == USER else "answer"
                print(f"    {tag:6} status={status} {at:7} {text!r}" + ("" if status == DONE and text else "  <- not read"))
if len(reads) > 1:
    base = next(iter(reads.values()))
    for label, r in reads.items():
        for db in ("summaries", "steps"):
            if r[db] != base[db]:
                print(f"schema of {db} differs in {label}:")
                for sql in sorted(set(base[db] or []) - set(r[db] or [])):
                    print("  -", " ".join(sql.split())[:160])
                for sql in sorted(set(r[db] or []) - set(base[db] or [])):
                    print("  +", " ".join(sql.split())[:160])
    print("schemas", "identical" if all(r["summaries"] == base["summaries"] and r["steps"] == base["steps"]
                                        for r in reads.values()) else "DIFFER")
