#!/usr/bin/env python3
import json
import re
import sys
from catalog import Catalog

try:
    request = json.loads(sys.stdin.buffer.readline(65537))
    if set(request) != {'directory', 'installationId', 'catalogId', 'manifestHash', 'checkpoint', 'expectedEpoch', 'recoveryId'}:
        raise ValueError('CATALOG_REQUEST_INVALID')
    with Catalog(request['directory'], request['installationId'], request['catalogId']) as catalog:
        if catalog.manifest_hash != request['manifestHash']:
            raise ValueError('CATALOG_MANIFEST_MISMATCH')
        catalog.require_checkpoint(request['checkpoint'])
        epoch = catalog.advance(request['expectedEpoch'], request['recoveryId'])
        print(json.dumps({'epoch': epoch, 'checkpoint': catalog.checkpoint()}), flush=True)
except Exception as error:
    code = str(error)
    if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,100}', code): code = 'CATALOG_UNCERTAIN'
    print(json.dumps({'error': code}), flush=True)
    sys.exit(1)
