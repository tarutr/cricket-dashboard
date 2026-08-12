#!/usr/bin/env python3
"""
No-cache local review server for cricdb.
Serves the repo over HTTP with Cache-Control headers that force fresh module loads on every reload.
Use: python3 serve.py [PORT]
Default port: 8000 (required for R2 CORS). For testing, use: python3 serve.py 8001
"""

import http.server
import socketserver
import sys
from pathlib import Path

PORT = 8000
if len(sys.argv) > 1:
    PORT = int(sys.argv[1])

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler that sends no-cache headers on every response."""

    def end_headers(self):
        # Inject no-cache headers before closing the header block
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

if __name__ == '__main__':
    try:
        with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
            print(f"Serving on http://localhost:{PORT}/ (no-cache mode)")
            print("Every reload will refetch fresh modules.")
            print("Press Ctrl+C to stop")
            httpd.serve_forever()
    except OSError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
