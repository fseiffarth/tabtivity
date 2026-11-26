#!/usr/bin/env python3
# Stub Anthropic Messages API on loopback, so Claude can be driven offline and
# for free through turns no real model would take (ANTHROPIC_BASE_URL).
#   stub_anthropic.py <port> <log.jsonl>
# Endpoint: http://127.0.0.1:<port> (POST /v1/messages, streaming or not;
# /v1/messages/count_tokens answers a fixed count).
# Only a request that offers tools (the agent's own loop, a subagent's) obeys
# the prompt's directive; side requests (titles, summaries) get the answer.
# The newest user message holding
#   STUB:CALL <tool> <json>                  makes the model call that tool, then answer "stub answer done";
#   STUB:SEQ <tool> <json> ;; <tool> <json>  calls them one per step;
#   STUB:ERR <status> <error-type>           answers that HTTP error instead (400 invalid_request_error,
#                                            401 authentication_error, 429 rate_limit_error, ...).
# Every request is logged: offered tools, the directive's prompt, tool results.
import json,os,re,sys,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
port=int(sys.argv[1]); log=open(sys.argv[2],'a',buffering=1)
def texts(m):
    c=m.get('content')
    if isinstance(c,str): return [c]
    return [b.get('text','') for b in c or [] if isinstance(b,dict) and b.get('type')=='text']
def results(m):
    c=m.get('content')
    return [b for b in c or [] if isinstance(b,dict) and b.get('type')=='tool_result'] if isinstance(c,list) else []
class H(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*a): pass
    def _json(self,o,code=200):
        b=json.dumps(o).encode(); self.send_response(code); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        log.write(json.dumps({'GET':self.path})+'\n')
        self._json({'data':[{'id':'claude-stub','type':'model','display_name':'stub'}],'has_more':False})
    def do_HEAD(self):
        self.send_response(200); self.send_header('content-length','0'); self.end_headers()
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('content-length',0)) or 0)
        try: d=json.loads(body)
        except Exception: d={}
        if 'count_tokens' in self.path: return self._json({'input_tokens':100})
        msgs=d.get('messages',[]); tools=[t.get('name') for t in d.get('tools',[]) or []]
        # The newest user message that carries words (not only tool results).
        at=max((i for i,m in enumerate(msgs) if m.get('role')=='user' and any(t.strip() for t in texts(m))),default=-1)
        prompt=' '.join(texts(msgs[at])) if at>=0 else ''
        done=[r for m in msgs[at+1:] for r in results(m)]
        rec={'path':self.path,'model':d.get('model'),'stream':d.get('stream'),'tools':tools,'prompt':prompt[-300:],
             'tool_results':[str(r.get('content'))[:500]+(' [is_error]' if r.get('is_error') else '') for r in done]}
        log.write(json.dumps(rec)+'\n')
        m=re.search(r'STUB:(CALL|SEQ|ERR) ([^\n<]*)',prompt) if tools else None
        if m and m.group(1)=='ERR':
            status,_,kind=m.group(2).strip().partition(' ')
            return self._json({'type':'error','error':{'type':kind or 'api_error','message':'stub error'}},int(status))
        seq=[]
        if m:
            for part in m.group(2).split(';;'):
                tn,_,arg=part.strip().partition(' '); seq.append((tn,arg.strip() or '{}'))
        call=seq[len(done)] if len(done)<len(seq) else None
        mid=f'msg_{int(time.time()*1000)}'
        # STUB_CACHE_READ / STUB_CACHE_WRITE (env) put cache tokens in the usage, to tell the counts apart.
        usage={'input_tokens':100,'output_tokens':10,'cache_creation_input_tokens':int(os.environ.get('STUB_CACHE_WRITE','0')),'cache_read_input_tokens':int(os.environ.get('STUB_CACHE_READ','0'))}
        if call:
            block={'type':'tool_use','id':f'toolu_{int(time.time()*1000)}','name':call[0],'input':json.loads(call[1])}
            stop='tool_use'
        else:
            block={'type':'text','text':'stub answer done'}; stop='end_turn'
        if not d.get('stream'):
            return self._json({'id':mid,'type':'message','role':'assistant','model':d.get('model','stub'),'content':[block],
                               'stop_reason':stop,'stop_sequence':None,'usage':usage})
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.send_header('cache-control','no-cache'); self.send_header('connection','close'); self.end_headers()
        def ev(kind,**o):
            o['type']=kind; self.wfile.write(f'event: {kind}\ndata: {json.dumps(o)}\n\n'.encode()); self.wfile.flush()
        ev('message_start',message={'id':mid,'type':'message','role':'assistant','model':d.get('model','stub'),'content':[],
                                    'stop_reason':None,'stop_sequence':None,'usage':usage})
        if call:
            ev('content_block_start',index=0,content_block=dict(block,input={}))
            ev('content_block_delta',index=0,delta={'type':'input_json_delta','partial_json':call[1]})
        else:
            ev('content_block_start',index=0,content_block={'type':'text','text':''})
            for w in ('stub ','answer ','done'): ev('content_block_delta',index=0,delta={'type':'text_delta','text':w})
        ev('content_block_stop',index=0)
        ev('message_delta',delta={'stop_reason':stop,'stop_sequence':None},usage={'output_tokens':10})
        ev('message_stop')
        self.close_connection=True
ThreadingHTTPServer(('127.0.0.1',port),H).serve_forever()
