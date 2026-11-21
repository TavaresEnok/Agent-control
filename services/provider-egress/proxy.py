#!/usr/bin/env python3
"""Fixed CONNECT-only TLS tunnel; never decrypts or logs provider requests."""
import ipaddress
import os
import re
import select
import socket
import socketserver
import threading
import time

import sys

HOST = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+')
# Locked mode default. A personal installation passes its provider hosts in AC_EGRESS_ALLOW.
DEFAULT_HOSTS = ('chatgpt.com', 'auth.openai.com')

def allowed_hosts(environ):
    raw = environ.get('AC_EGRESS_ALLOW', '').strip()
    if not raw:
        return frozenset(DEFAULT_HOSTS)
    hosts = [item.strip().lower() for item in raw.split(',') if item.strip()]
    if not hosts or len(hosts) > 64 or not all(HOST.fullmatch(host) for host in hosts):
        raise SystemExit('AC_EGRESS_ALLOW invalid')
    return frozenset(hosts)

def egress_mode(environ):
    mode = environ.get('AC_EGRESS_MODE', 'enforce')
    if mode not in ('enforce', 'observe'):
        raise SystemExit('AC_EGRESS_MODE invalid')
    return mode

ALLOWED_HOSTS = allowed_hosts(os.environ)
MODE = egress_mode(os.environ)

def note(kind, host):
    # Host names only: never a path, header or byte of the tunnel.
    print(f'egress-{kind} {host}', file=sys.stderr, flush=True)
SLOTS = threading.BoundedSemaphore(32)

def target_from_header(header, allowed=None, mode=None):
    allowed = ALLOWED_HOSTS if allowed is None else allowed
    mode = MODE if mode is None else mode
    if len(header) > 8192 or not header.endswith(b'\r\n\r\n'):
        raise ValueError('invalid header')
    lines = header.decode('ascii', errors='strict').split('\r\n')
    match = re.fullmatch(r'CONNECT ([a-z0-9.-]+):443 HTTP/1\.[01]', lines[0])
    if not match or not HOST.fullmatch(match.group(1)):
        raise ValueError('target denied')
    host = match.group(1)
    if host not in allowed:
        # Observe mode learns the real destinations before enforcement; it still refuses private addresses below.
        note('observe' if mode == 'observe' else 'denied', host)
        if mode != 'observe':
            raise ValueError('target denied')
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(':')
        if not sep or not re.fullmatch(r'[A-Za-z0-9-]+', name):
            raise ValueError('invalid header')
        if name.lower() in {'content-length', 'transfer-encoding', 'proxy-authorization'}:
            raise ValueError('unsupported header')
        # Some clients (undici) send the Host header without the port.
        if name.lower() == 'host' and value.strip().lower() not in (host, host + ':443'):
            raise ValueError('host mismatch')
    return host

def connect_public(host):
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    seen = set()
    for family, kind, proto, _, address in addresses[:8]:
        if address[0] in seen or not ipaddress.ip_address(address[0]).is_global:
            continue
        seen.add(address[0])
        upstream = socket.socket(family, kind, proto)
        upstream.settimeout(5)
        try:
            upstream.connect(address)
            upstream.settimeout(10)
            return upstream
        except OSError:
            upstream.close()
    raise OSError('no public provider address')

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not SLOTS.acquire(blocking=False):
            self.request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
            return
        upstream = None
        connected = False
        try:
            self.request.settimeout(5)
            header = bytearray()
            while b'\r\n\r\n' not in header:
                chunk = self.request.recv(min(1024, 8193 - len(header)))
                if not chunk or len(header) + len(chunk) > 8192:
                    raise ValueError('invalid header')
                header.extend(chunk)
            end = header.index(b'\r\n\r\n') + 4
            host = target_from_header(bytes(header[:end]))
            upstream = connect_public(host)
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            connected = True
            if len(header) > end:
                upstream.sendall(header[end:])
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                ready, _, _ = select.select([self.request, upstream], [], [], min(180, max(0, deadline - time.monotonic())))
                if not ready:
                    break
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is self.request else self.request).sendall(data)
        except (OSError, ValueError, UnicodeError):
            if not connected:
                try:
                    self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
                except OSError:
                    pass
        finally:
            if upstream is not None:
                upstream.close()
            SLOTS.release()

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 32

if __name__ == '__main__':
    # Fixed interface/port, no host paths, credentials or arbitrary destinations.
    with Server(('0.0.0.0', 8080), Handler) as server:
        server.serve_forever(poll_interval=0.5)
