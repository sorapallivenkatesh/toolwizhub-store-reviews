#!/usr/bin/env python3
"""dev.py — run the Lambda handler locally over plain HTTP (no SAM/Docker needed).

    npm run api   →   GET http://localhost:3001/reviews?store=appstore&id=618783545

It shapes an HTTP-API-style event and calls reviews.handler in-process, so you get
the exact same code path as production without a container. App Store works with
stdlib only; the Play Store path needs `pip install google-play-scraper`.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import reviews  # the Lambda module (reviews.handler)

PORT = int(os.environ.get("PORT", "3001"))


class Proxy(BaseHTTPRequestHandler):
    def _dispatch(self, method):
        u = urlparse(self.path)
        event = {
            "requestContext": {"http": {"method": method, "path": u.path}},
            "rawPath": u.path,
            "queryStringParameters": {k: v[0] for k, v in parse_qs(u.query).items()},
            "body": None,
            "isBase64Encoded": False,
        }
        out = reviews.handler(event, None)
        body = (out.get("body") or "").encode("utf-8")
        self.send_response(out.get("statusCode", 200))
        for k, v in (out.get("headers") or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._dispatch("GET")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    def log_message(self, *_):
        print(f"dev: {self.command} {self.path}")


if __name__ == "__main__":
    os.environ.setdefault("ALLOW_ORIGIN", "*")  # permissive for local dev
    print(f"store-reviews API (dev) → http://localhost:{PORT}/reviews?store=appstore&id=618783545")
    ThreadingHTTPServer(("127.0.0.1", PORT), Proxy).serve_forever()
