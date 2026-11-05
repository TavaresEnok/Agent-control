#!/usr/bin/env python3
"""Hold a catalog effect lease until the calling controller closes stdin.

The pending event is durable before READY. EOF on controller crash releases the
OS lock but deliberately does not resolve the event.
"""
import json
import re
import sys
from catalog import Catalog


def main():
    line = sys.stdin.buffer.readline(65537)
    if len(line) > 65536:
        raise ValueError('CATALOG_REQUEST_INVALID')
    request = json.loads(line)
    if set(request) != {'directory', 'installationId', 'catalogId', 'manifestHash', 'epoch', 'kind', 'authority', 'identity', 'operation', 'requestDigest'}:
        raise ValueError('CATALOG_REQUEST_INVALID')
    with Catalog(request['directory'], request['installationId'], request['catalogId']) as catalog:
        if catalog.manifest_hash != request['manifestHash']:
            raise ValueError('CATALOG_MANIFEST_MISMATCH')
        catalog.begin(request['epoch'], request['kind'], request['authority'], request['operation'], request['requestDigest'], request['identity'])
        print(json.dumps({'state': 'pending'}), flush=True)
        while sys.stdin.buffer.read(4096):
            pass


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,100}', code):
            code = 'CATALOG_UNCERTAIN'
        print(json.dumps({'error': code}), flush=True)
        sys.exit(1)
