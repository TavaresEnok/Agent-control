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

ALLOWED_HOSTS = frozenset({'chatgpt.com', 'auth.openai.com'})
SLOTS = threading.BoundedSemaphore(32)

def target_from_header(header):
    if len(header) > 8192 or not header.endswith(b'\r\n\r\n'):
        raise ValueError('invalid header')
    lines = header.decode('ascii', errors='strict').split('\r\n')
    match = re.fullmatch(r'CONNECT ([a-z0-9.-]+):443 HTTP/1\.[01]', lines[0])
    if not match or match.group(1) not in ALLOWED_HOSTS:
        raise ValueError('target denied')
    host = match.group(1)
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(':')
        if not sep or not re.fullmatch(r'[A-Za-z0-9-]+', name):
            raise ValueError('invalid header')
        if name.lower() in {'content-length', 'transfer-encoding', 'proxy-authorization'}:
            raise ValueError('unsupported header')
        if name.lower() == 'host' and value.strip().lower() != host + ':443':
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
