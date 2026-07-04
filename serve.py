import os, http.server, socketserver
os.chdir('/Users/adriano/Documents/Progetti/low-freq-hunter')
PORT = 8765
Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.serve_forever()
