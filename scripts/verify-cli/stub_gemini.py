#!/usr/bin/env python3
# Stub Gemini endpoint on loopback (streamGenerateContent SSE): every request
# answers "stub answer done". Point a CLI at it with GOOGLE_GEMINI_BASE_URL.
#   stub_gemini.py <port> <log.jsonl>
# A user turn holding `STUB:CALL <tool> <json>` makes the model call that tool
# once (a functionCall part), then answer "stub answer done" once the tool's
# result comes back. Each request's log line lists the tools offered.
# `STUB:FAIL` in the last user text answers HTTP 500 instead (a turn that
# ends in an error); `STUB:SLOW <secs>` waits that long before answering (a
# turn to interrupt). Every `STUBMARK-<WORD>` anywhere in a request is logged
# as `marks`, to see what a hook injected into the model's context.
import json,re,sys,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
port=int(sys.argv[1]); log=open(sys.argv[2],'a',buffering=1)
def tools(req):
    return [d.get('name') for t in req.get('tools') or [] for d in t.get('functionDeclarations') or t.get('function_declarations') or []]
def call(req):
    """The tool call a `STUB:CALL` in the last user text asks for, unless a tool already answered."""
    contents=req.get('contents') or []
    if not contents: return None
    last=contents[-1]
    if any('functionResponse' in p or 'function_response' in p for p in last.get('parts') or []): return None
    text=' '.join(p.get('text','') for p in last.get('parts') or [] if isinstance(p,dict))
    m=re.search(r'STUB:CALL (\S+) (\{.*\})',text,re.S)
    if not m: return None
    try: args=json.loads(m.group(2))
    except ValueError: return None
    return {'name':m.group(1),'args':args}
def last_text(req):
    contents=req.get('contents') or []
    if not contents: return ''
    return ' '.join(p.get('text','') for p in contents[-1].get('parts') or [] if isinstance(p,dict))
class H(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*a): pass
    def do_GET(self):
        log.write(json.dumps({'GET':self.path})+'\n'); b=b'{}'; self.send_response(200); self.send_header('content-length','2'); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('content-length',0)) or 0)
        try: req=json.loads(body or b'{}')
        except ValueError: req={}
        fc=call(req) if isinstance(req,dict) else None
        text=last_text(req) if isinstance(req,dict) else ''
        marks=sorted(set(re.findall(r'STUBMARK-[A-Z0-9-]+',body.decode('utf-8','replace'))))
        log.write(json.dumps({'POST':self.path,'n':len(body),'tools':tools(req) if isinstance(req,dict) else [],'call':fc,'marks':marks})+'\n')
        if 'STUB:FAIL' in text and not fc:
            b=b'{"error":{"code":500,"message":"stub failure","status":"INTERNAL"}}'
            self.send_response(500); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        slow=re.search(r'STUB:SLOW (\d+)',text)
        if slow and not fc: time.sleep(int(slow.group(1)))
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.send_header('connection','close'); self.end_headers()
        if fc:
            o={'candidates':[{'content':{'role':'model','parts':[{'functionCall':fc}]},'index':0,'finishReason':'STOP'}],
               'usageMetadata':{'promptTokenCount':10,'candidatesTokenCount':3,'totalTokenCount':13}}
            self.wfile.write(b'data: '+json.dumps(o).encode()+b'\r\n\r\n'); self.wfile.flush()
            self.close_connection=True
            return
        for i,w in enumerate(('stub ','answer ','done')):
            o={'candidates':[{'content':{'role':'model','parts':[{'text':w}]},'index':0}]}
            if i==2:
                o['candidates'][0]['finishReason']='STOP'; o['usageMetadata']={'promptTokenCount':10,'candidatesTokenCount':3,'totalTokenCount':13}
            self.wfile.write(b'data: '+json.dumps(o).encode()+b'\r\n\r\n'); self.wfile.flush(); time.sleep(0.05)
        self.close_connection=True
ThreadingHTTPServer(('127.0.0.1',port),H).serve_forever()
