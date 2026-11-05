#!/usr/bin/env python3
import json
import sys
from catalog import Catalog

try:
    request = json.loads(sys.stdin.buffer.readline(65537))
    if set(request) != {'directory', 'installationId', 'catalogId', 'manifestHash', 'epoch'}:
        raise ValueError('CATALOG_REQUEST_INVALID')
    with Catalog(request['directory'], request['installationId'], request['catalogId']) as catalog:
        if catalog.manifest_hash != request['manifestHash']:
            raise ValueError('CATALOG_MANIFEST_MISMATCH')
        epoch, _ = catalog.state()
        if epoch != request['epoch']:
            raise ValueError('CATALOG_EPOCH_MISMATCH')
        print(json.dumps({'manifest': catalog.manifest, 'epoch': epoch}), flush=True)
except Exception:
    print(json.dumps({'error': 'CATALOG_UNCERTAIN'}), flush=True)
    sys.exit(1)
