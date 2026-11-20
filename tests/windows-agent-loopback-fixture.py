from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from windows_agent.core import WindowsAgent
from windows_agent.server import AgentServer, Pairing, certificate_fingerprint, create_certificate, ssl_context


class MarkerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    roots: dict[str, Path] = {}

    def log_message(self, *_args):
        return

    def do_GET(self):
        route = urlparse(self.path).path
        parts = route.strip("/").split("/")
        if len(parts) != 2 or parts[1] != "vee-release.json" or parts[0] not in self.roots:
            self.send_error(404)
            return
        try:
            body = (self.roots[parts[0]] / "current" / "vee-release.json").read_bytes()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True


def main():
    if len(sys.argv) != 2:
        raise SystemExit("A temporary fixture directory is required")
    base = Path(sys.argv[1]).resolve()
    base.mkdir(parents=True, exist_ok=False)
    state_root = base / "agent-state"
    roots = {"static-project": base / "managed-static", "php-project": base / "managed-php"}

    MarkerHandler.roots = roots
    marker_server = ThreadingHTTPServer(("127.0.0.1", 0), MarkerHandler)
    marker_thread = threading.Thread(target=marker_server.serve_forever, daemon=True)
    marker_thread.start()

    agent = WindowsAgent(state_root)
    marker_port = marker_server.server_address[1]
    static_info = agent.register_project({
        "id": "static-project",
        "root": str(roots["static-project"]),
        "kind": "static",
        "entrypoint": "index.html",
        "healthUrl": f"http://127.0.0.1:{marker_port}/static-project/vee-release.json",
    })
    php_info = agent.register_project({
        "id": "php-project",
        "root": str(roots["php-project"]),
        "kind": "php",
        "entrypoint": "index.php",
        "healthUrl": f"http://127.0.0.1:{marker_port}/php-project/vee-release.json",
    })

    create_certificate(state_root, "127.0.0.1")
    pairing = Pairing(state_root)
    pairing_code = pairing.enable()
    agent_server = AgentServer(
        ("127.0.0.1", 0),
        agent,
        pairing,
        tls_context=ssl_context(state_root),
    )
    agent_thread = threading.Thread(target=agent_server.serve_forever, daemon=True)
    agent_thread.start()

    # The one-time code is sent only through this test process pipe and never written to disk.
    ready = {
        "agentPort": agent_server.server_address[1],
        "markerPort": marker_port,
        "certificateFingerprint": certificate_fingerprint(state_root),
        "pairingCode": pairing_code,
        "staticRoot": str(roots["static-project"]),
        "phpRoot": str(roots["php-project"]),
        "staticBootstrap": static_info["currentReleaseId"],
        "phpBootstrap": php_info["currentReleaseId"],
        "staticHealthPath": static_info["healthPath"],
        "phpHealthPath": php_info["healthPath"],
    }
    print(json.dumps(ready, separators=(",", ":")), flush=True)

    try:
        sys.stdin.readline()
    finally:
        agent_server.shutdown()
        agent_server.server_close()
        marker_server.shutdown()
        marker_server.server_close()
        agent_thread.join(3)
        marker_thread.join(3)


if __name__ == "__main__":
    main()
