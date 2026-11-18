"""OpenCode's session database, read-only: tables, columns, and each tool part.

    python3 scripts/verify-cli/opencode/db.py <opencode.db> [session-id]

The db sits under <home>/.local/share/opencode/ of a turns.py run. Shows
whether the tables the app reads (session_v2, session_message, session_part)
kept their shape, and every tool call's stored input and state.
"""
import sqlite3,sys,json
db,sid=sys.argv[1],sys.argv[2] if len(sys.argv)>2 else None
c=sqlite3.connect(f'file:{db}?mode=ro',uri=True); c.row_factory=sqlite3.Row
print([r[0] for r in c.execute("select name from sqlite_master where type='table'") if r[0].startswith(('session','blob','job','sched'))])
print('session cols',[r[1] for r in c.execute('pragma table_info(session_message)')])
print('session_part rows',c.execute('select count(*) from session_part').fetchone()[0])
for s in c.execute('select id,parent_id,title from session_v2').fetchall(): print(dict(s))
kinds={}
for r in c.execute('select * from session_message order by session_id,seq'):
    d=dict(r)
    raw=d.get('data') or d.get('content')
    try: o=json.loads(raw)
    except Exception: continue
    cont=o if isinstance(o,list) else o.get('content',[]) if isinstance(o,dict) else []
    for it in (cont or []):
        if isinstance(it,dict) and it.get('type')=='tool':
            st=it.get('state') or {}
            print(it.get('name') or it.get('tool'), json.dumps({k:it[k] for k in it if k not in('state',)})[:160], '| state', json.dumps(st)[:520])
