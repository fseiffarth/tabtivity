#!/usr/bin/env python3
# Stub OpenAI-compatible model + MCP server on loopback, so a CLI can be driven
# through calls no real model would make, offline and for free.
#   stub_openai.py <port> <log.jsonl>
# Model endpoint: http://127.0.0.1:<port>/v1 (chat completions, streaming).
# MCP endpoints:  /mcp/web (web_search, web_fetch), /mcp/help (the help search).
# A user prompt holding
#   STUB:CALL <tool> <json>                  makes the model call that tool, then answer "stub answer done";
#   STUB:SEQ <tool> <json> ;; <tool> <json>  calls them one per turn step.
# Every request is logged: offered tools, last prompt, tool results.
import json,os,sys,re,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from common import SLUG  # noqa: E402
port=int(sys.argv[1]); log=open(sys.argv[2],'a',buffering=1)
TOOLS=[{'name':'web_search','description':'search','inputSchema':{'type':'object','properties':{'query':{'type':'string'}},'required':['query']}},
       {'name':'web_fetch','description':'fetch','inputSchema':{'type':'object','properties':{'url':{'type':'string'}},'required':['url']}}]
HELP=[{'name':f'{SLUG}_help_search','description':'help','inputSchema':{'type':'object','properties':{'q':{'type':'string'}}}}]
def text_of(m):
    c=m.get('content')
    if isinstance(c,str): return c
    if isinstance(c,list): return ' '.join(x.get('text','') for x in c if isinstance(x,dict))
    return ''
class H(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*a): pass
    def _json(self,o,code=200,hdr=None):
        b=json.dumps(o).encode(); self.send_response(code); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(b)))
        for k,v in (hdr or {}).items(): self.send_header(k,v)
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        log.write(json.dumps({'GET':self.path})+'\n')
        if self.path.endswith('/models'): return self._json({'object':'list','data':[{'id':'stub','object':'model'}]})
        self.send_response(405); self.send_header('content-length','0'); self.end_headers()
    def do_DELETE(self): self.send_response(204); self.send_header('content-length','0'); self.end_headers()
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('content-length',0)) or 0)
        try: d=json.loads(body)
        except Exception: d={}
        if self.path.startswith('/mcp/'):
            return self.mcp(d)
        msgs=d.get('messages',[])
        tools=[t.get('function',{}).get('name') for t in d.get('tools',[])]
        last=msgs[-1] if msgs else {}
        users=[m for m in msgs if m.get('role')=='user']
        prompt=text_of(users[-1]) if users else ''
        after=[m for m in msgs[msgs.index(users[-1])+1:]] if users else []
        ntool=sum(1 for m in after if m.get('role')=='tool')
        rec={'path':self.path,'tools':tools,'prompt':prompt[-300:],'last_role':last.get('role'),'tool_results':[text_of(m)[:700] for m in after if m.get('role')=='tool']}
        log.write(json.dumps(rec)+'\n')
        seq=[]
        m=re.search(r'STUB:(?:CALL|SEQ) (.*)',prompt,re.S)
        if m:
            for part in m.group(1).split(';;'):
                tn,_,arg=part.strip().partition(' '); seq.append((tn,arg.strip() or '{}'))
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.send_header('cache-control','no-cache'); self.send_header('connection','close'); self.end_headers()
        def chunk(delta,finish=None):
            o={'id':'c1','object':'chat.completion.chunk','created':int(time.time()),'model':'stub','choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
            if finish: o['usage']={'prompt_tokens':100,'completion_tokens':10,'total_tokens':110}
            self.wfile.write(b'data: '+json.dumps(o).encode()+b'\n\n'); self.wfile.flush()
        chunk({'role':'assistant','content':''})
        if ntool<len(seq):
            tn,arg=seq[ntool]
            chunk({'tool_calls':[{'index':0,'id':f'call_{int(time.time()*1000)}','type':'function','function':{'name':tn,'arguments':arg}}]})
            chunk({},'tool_calls')
        else:
            for w in ('stub ','answer ','done'): chunk({'content':w})
            chunk({},'stop')
        self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush(); self.close_connection=True
    def mcp(self,d):
        i=d.get('id'); meth=d.get('method')
        log.write(json.dumps({'mcp':self.path,'method':meth})+'\n')
        if i is None:
            self.send_response(202); self.send_header('content-length','0'); self.end_headers(); return
        if meth=='initialize':
            r={'protocolVersion':d['params'].get('protocolVersion','2025-03-26'),'capabilities':{'tools':{}},'serverInfo':{'name':'stub','version':'1'}}
        elif meth=='tools/list': r={'tools':HELP if 'help' in self.path else TOOLS}
        elif meth=='tools/call': r={'content':[{'type':'text','text':'stub tool result'}]}
        else: r={}
        self._json({'jsonrpc':'2.0','id':i,'result':r})
ThreadingHTTPServer(('127.0.0.1',port),H).serve_forever()
