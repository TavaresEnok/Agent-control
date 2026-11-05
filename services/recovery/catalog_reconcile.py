#!/usr/bin/env python3
"""Hold catalog fence throughout host reconciliation and admission CAS.

This helper only journals evidence supplied by the trusted orchestrator; it
cannot itself authenticate host evidence. The orchestrator must do that first.
"""
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
        _, pending = catalog.state()
        print(json.dumps({'state': 'locked', 'epoch': epoch, 'manifest': catalog.manifest, 'pending': pending}), flush=True)
        command = json.loads(sys.stdin.buffer.readline(1048577))
        if set(command) != {'proofs'} or not isinstance(command['proofs'], list): raise ValueError('CATALOG_REQUEST_INVALID')
        scope = {(item['kind'], item['id']) for item in catalog.manifest['authorities']}
        proofs = {}
        for item in command['proofs']:
            if not isinstance(item, dict) or set(item) != {'kind', 'authority', 'proofDigest'} or not isinstance(item['proofDigest'], str) or not re.fullmatch(r'[a-f0-9]{64}', item['proofDigest']):
                raise ValueError('CATALOG_PROOF_INVALID')
            key = (item['kind'], item['authority'])
            if key not in scope or key in proofs: raise ValueError('CATALOG_PROOF_INVALID')
            proofs[key] = item['proofDigest']
        if set(proofs) != scope: raise ValueError('CATALOG_PROOF_INCOMPLETE')
        for (kind, authority), proof in sorted(proofs.items()):
            catalog._append({'type':'authority-sweep', 'epoch':epoch, 'kind':kind, 'authority':authority, 'proofDigest':proof})
        for operation, value in sorted(pending.items()):
            proof = proofs.get((value['kind'], value['authority']))
            if not proof: raise ValueError('CATALOG_PROOF_INCOMPLETE')
            catalog._append({'type':'resolved', 'epoch':epoch, 'operation':operation, 'proofDigest':proof})
        print(json.dumps({'state':'recorded', 'checkpoint':catalog.checkpoint()}), flush=True)
        # Do not release the lock until the controller commits admission or dies.
        while sys.stdin.buffer.read(4096): pass
except Exception as error:
    code = str(error)
    if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,100}', code): code = 'CATALOG_UNCERTAIN'
    print(json.dumps({'error':code}), flush=True)
    sys.exit(1)
