#!/usr/bin/env python3
# Stub Gemini endpoint on loopback (streamGenerateContent SSE): every request
# answers "stub answer done". Point a CLI at it with GOOGLE_GEMINI_BASE_URL.
#   stub_gemini.py <port> <log.jsonl>
import json,sys,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
port=int(sys.argv[1]); log=open(sys.argv[2],'a',buffering=1)
class H(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*a): pass
    def do_GET(self):
        log.write(json.dumps({'GET':self.path})+'\n'); b=b'{}'; self.send_response(200); self.send_header('content-length','2'); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('content-length',0)) or 0)
        log.write(json.dumps({'POST':self.path,'n':len(body)})+'\n')
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.send_header('connection','close'); self.end_headers()
        for i,w in enumerate(('stub ','answer ','done')):
            o={'candidates':[{'content':{'role':'model','parts':[{'text':w}]},'index':0}]}
            if i==2:
                o['candidates'][0]['finishReason']='STOP'; o['usageMetadata']={'promptTokenCount':10,'candidatesTokenCount':3,'totalTokenCount':13}
            self.wfile.write(b'data: '+json.dumps(o).encode()+b'\r\n\r\n'); self.wfile.flush(); time.sleep(0.05)
        self.close_connection=True
ThreadingHTTPServer(('127.0.0.1',port),H).serve_forever()
