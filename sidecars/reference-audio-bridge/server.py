"""Optional GPT-SoVITS upload bridge. Run beside the TTS server, not on the DSH client.
Only Python stdlib is required. The suite never starts this service automatically.
"""
import argparse
import hmac
import json
import os
from pathlib import Path
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

MAX_BYTES = 16 * 1024 * 1024

def audio_extension(data):
    if data.startswith(b'RIFF') and data[8:12] == b'WAVE': return 'wav'
    if data.startswith(b'ID3') or (len(data)>2 and data[0]==255 and data[1]&224==224): return 'mp3'
    if data.startswith(b'OggS'): return 'ogg'
    if data.startswith(b'fLaC'): return 'flac'
    return None

def handler_for(upstream, folder, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def reply(self, status, data, mime='application/json'):
            if isinstance(data, dict): data=json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type',mime)
            self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_POST(self):
            if token and not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token):
                self.reply(401,{'error':'Unauthorized'}); return
            try: length=int(self.headers.get('Content-Length','0'))
            except ValueError: length=0
            if not 0<length<=MAX_BYTES:
                self.reply(413,{'error':'Invalid upload size'}); return
            data=self.rfile.read(length)
            if self.path=='/reference-audio':
                ext=audio_extension(data)
                if not ext: self.reply(400,{'error':'Unsupported audio'}); return
                folder.mkdir(parents=True,exist_ok=True)
                file=(folder/(secrets.token_hex(16)+'.'+ext)).resolve()
                with file.open('xb') as output: output.write(data)
                self.reply(200,{'path':str(file),'format':ext})
            elif self.path=='/tts':
                try:
                    payload=json.loads(data)
                    if not isinstance(payload,dict): raise ValueError()
                    request=Request(upstream.rstrip('/')+'/tts',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
                    with urlopen(request,timeout=300) as response:
                        output=response.read(MAX_BYTES+1)
                        if len(output)>MAX_BYTES: self.reply(502,{'error':'Audio response too large'}); return
                        self.reply(response.status,output,response.headers.get('Content-Type','audio/wav'))
                except HTTPError as error: self.reply(error.code,{'error':'Upstream TTS rejected request'})
                except Exception: self.reply(502,{'error':'Upstream TTS unavailable'})
            else: self.reply(404,{'error':'Not found'})
        def do_GET(self): self.reply(200,{'ok':True}) if self.path=='/health' else self.reply(404,{'error':'Not found'})
    return Handler

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=9881)
    parser.add_argument('--upstream',default='http://127.0.0.1:9880')
    parser.add_argument('--directory',default='./reference-audio')
    args=parser.parse_args()
    token=os.getenv('REFERENCE_AUDIO_BRIDGE_TOKEN','')
    if args.host not in ('127.0.0.1','localhost','::1') and not token:
        parser.error('Set REFERENCE_AUDIO_BRIDGE_TOKEN before binding to a network interface')
    ThreadingHTTPServer((args.host,args.port),handler_for(args.upstream,Path(args.directory),token)).serve_forever()
