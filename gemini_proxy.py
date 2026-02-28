import http.server
import socketserver
import urllib.request
import urllib.error
import re
import sys

PORT = 8080
TARGET_URL = "https://gemini.google.com"
USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")

    def handle_request(self, method):
        url = TARGET_URL + self.path
        
        # Headers setup
        headers = {key: val for key, val in self.headers.items() if key.lower() not in ['host', 'accept-encoding']}
        headers['User-Agent'] = USER_AGENT
        headers['Host'] = "gemini.google.com"
        headers['Origin'] = "https://gemini.google.com"
        headers['Referer'] = "https://gemini.google.com/"

        try:
            data = None
            if method == "POST":
                content_len = int(self.headers.get('Content-Length', 0))
                data = self.rfile.read(content_len)

            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req) as response:
                self.send_response(response.status)
                
                # Copy response headers
                for key, val in response.headers.items():
                    # Remove strict security headers that might block our proxy
                    if key.lower() in ['content-security-policy', 'content-encoding', 'transfer-encoding', 'strict-transport-security']:
                        continue
                    self.send_header(key, val)
                
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()

                content = response.read()

                # --- MAGICAL TRANSPILING ---
                # Only modify text/html or application/javascript
                content_type = response.headers.get('Content-Type', '')
                if 'html' in content_type or 'javascript' in content_type:
                    try:
                        text_content = content.decode('utf-8')
                        
                        # 1. Replace Optional Chaining: obj?.prop -> (obj && obj.prop)
                        # This is a very naive regex, but covers common cases
                        text_content = re.sub(r'(\w+)\?\.(\w+)', r'(\1 && \1.\2)', text_content)
                        
                        # 2. Replace Nullish Coalescing: a ?? b -> (a !== null && a !== undefined ? a : b)
                        # text_content = re.sub(r'(\w+)\s*\?\?\s*(\w+)', r'(\1 !== null && \1 !== undefined ? \1 : \2)', text_content)
                        
                        # 3. Inject Polyfills into HTML
                        if '<head>' in text_content:
                            polyfill = """<script>
                            if(!window.globalThis){window.globalThis=window;}
                            if(!Promise.allSettled){Promise.allSettled=function(p){return Promise.all(p.map(function(v){return Promise.resolve(v).then(function(val){return{status:'fulfilled',value:val}},function(r){return{status:'rejected',reason:r}})}))}};
                            if(!String.prototype.replaceAll){String.prototype.replaceAll=function(s,r){return this.split(s).join(r)}};
                            if(!Array.prototype.flat){Array.prototype.flat=function(d){d=isNaN(d)?1:Number(d);return d?Array.prototype.reduce.call(this,function(acc,cur){if(Array.isArray(cur)){acc.push.apply(acc,Array.prototype.flat.call(cur,d-1))}else{acc.push(cur)}return acc},[]):Array.prototype.slice.call(this)}};
                            </script>"""
                            text_content = text_content.replace('<head>', '<head>' + polyfill)

                        content = text_content.encode('utf-8')
                    except Exception as e:
                        print(f"Transpile Error: {e}")
                        pass # If decoding fails (binary), send as is

                self.wfile.write(content)

        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            print(f"Error: {e}")
            self.send_error(500, str(e))

print(f"Gemini Proxy running on port {PORT}...")
print(f"Please open http://localhost:{PORT} in Safari")
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
    httpd.serve_forever()
