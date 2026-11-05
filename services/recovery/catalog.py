#!/usr/bin/env python3
"""Host-local T30 catalog primitives. No external effect is authorized here.

Caller holds the returned lock for the entire side effect. An incomplete
entry survives process death; callers must reconcile it using physical proofs.
"""
import fcntl
import hashlib
import json
import os
import pathlib
import stat
import uuid


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def fail(code):
    raise ValueError(code)


def syncdir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_dir(path):
    path = pathlib.Path(path)
    if not path.is_absolute() or os.path.realpath(path) != str(path):
        fail('CATALOG_DIRECTORY_UNSAFE')
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        fail('CATALOG_DIRECTORY_UNSAFE')
    return path, st


def checked_file(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1:
        os.close(fd)
        fail('CATALOG_FILE_UNSAFE')
    return fd


def create_file(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        data = encode(value)
        if os.write(fd, data) != len(data):
            fail('CATALOG_WRITE_UNCERTAIN')
        os.fsync(fd)
    finally:
        os.close(fd)


def initialize(directory, installation_id, authorities):
    directory, st = private_dir(directory)
    installation_id = str(uuid.UUID(installation_id))
    if not isinstance(authorities, list) or not authorities:
        fail('CATALOG_SCOPE_REQUIRED')
    if any(not isinstance(item, dict) or set(item) != {'kind', 'id', 'identity'} or item['kind'] not in ('native', 'ssh') or not isinstance(item['id'], str) or not item['id'] or not isinstance(item['identity'], dict) or not item['identity'] for item in authorities):
        fail('CATALOG_SCOPE_INVALID')
    if len({(a['kind'], a['id']) for a in authorities}) != len(authorities):
        fail('CATALOG_SCOPE_INVALID')
    manifest = {'schemaVersion': 1, 'catalogId': str(uuid.uuid4()), 'installationId': installation_id,
                'directoryDevice': st.st_dev, 'directoryInode': st.st_ino, 'authorities': authorities}
    create_file(directory / 'manifest.json', manifest)
    create_file(directory / 'lock', {})
    create_file(directory / 'journal', {})
    syncdir(directory)
    return manifest


class Catalog:
    def __init__(self, directory, installation_id, catalog_id):
        self.directory, info = private_dir(directory)
        self.lockfd = checked_file(self.directory / 'lock', os.O_RDWR)
        try:
            fcntl.flock(self.lockfd, fcntl.LOCK_EX)
            fd = checked_file(self.directory / 'manifest.json', os.O_RDONLY)
            try:
                data = os.read(fd, 1048577)
            finally:
                os.close(fd)
            if len(data) > 1048576:
                fail('CATALOG_MANIFEST_INVALID')
            self.manifest = json.loads(data)
            if self.manifest.get('installationId') != installation_id or self.manifest.get('catalogId') != catalog_id or self.manifest.get('directoryDevice') != info.st_dev or self.manifest.get('directoryInode') != info.st_ino:
                fail('CATALOG_IDENTITY_MISMATCH')
            self.manifest_hash = hashlib.sha256(data).hexdigest()
            self.fd = checked_file(self.directory / 'journal', os.O_RDWR | os.O_APPEND)
            self.entries = self._read()
        except BaseException:
            if hasattr(self, 'fd'):
                os.close(self.fd)
            os.close(self.lockfd)
            raise

    def _read(self):
        os.lseek(self.fd, 0, os.SEEK_SET)
        raw = b''
        while True:
            chunk = os.read(self.fd, 65536)
            if not chunk:
                break
            raw += chunk
            if len(raw) > 64 * 1024 * 1024:
                fail('CATALOG_JOURNAL_TOO_LARGE')
        if not raw.startswith(b'{}'):
            fail('CATALOG_JOURNAL_INVALID')
        raw = raw[2:]
        if raw and not raw.endswith(b'\n'):
            fail('CATALOG_JOURNAL_TRUNCATED')
        entries, previous = [], self.manifest_hash
        for line in raw.splitlines():
            record = json.loads(line)
            if set(record) != {'seq', 'previous', 'entry', 'hash'} or record['seq'] != len(entries) + 1 or record['previous'] != previous:
                fail('CATALOG_JOURNAL_INVALID')
            check = hashlib.sha256(encode({key: record[key] for key in ('seq', 'previous', 'entry')})).hexdigest()
            if record['hash'] != check:
                fail('CATALOG_JOURNAL_INVALID')
            entries.append(record)
            previous = check
        return entries

    def _append(self, entry):
        record = {'seq': len(self.entries) + 1, 'previous': self.entries[-1]['hash'] if self.entries else self.manifest_hash, 'entry': entry}
        record['hash'] = hashlib.sha256(encode(record)).hexdigest()
        data = encode(record) + b'\n'
        if os.write(self.fd, data) != len(data):
            fail('CATALOG_WRITE_UNCERTAIN')
        os.fsync(self.fd)
        self.entries.append(record)
        return record

    def state(self):
        epoch = 1
        pending = {}
        scope = {(a['kind'], a['id']) for a in self.manifest['authorities']}
        for row in self.entries:
            event = row['entry']
            if event.get('type') == 'epoch':
                if event.get('epoch') != epoch + 1:
                    fail('CATALOG_EPOCH_INVALID')
                epoch += 1
            elif event.get('type') == 'pending':
                if event.get('epoch') != epoch or (event.get('kind'), event.get('authority')) not in scope or event.get('operation') in pending:
                    fail('CATALOG_EVENT_INVALID')
                pending[event['operation']] = event
            elif event.get('type') == 'resolved':
                if event.get('operation') not in pending or event.get('epoch') != epoch:
                    fail('CATALOG_EVENT_INVALID')
                del pending[event['operation']]
            else:
                fail('CATALOG_EVENT_INVALID')
        return epoch, pending

    def checkpoint(self):
        self.state()
        return {'catalogId': self.manifest['catalogId'], 'installationId': self.manifest['installationId'],
                'manifestHash': self.manifest_hash, 'seq': len(self.entries),
                'head': self.entries[-1]['hash'] if self.entries else self.manifest_hash}

    def require_checkpoint(self, checkpoint):
        if checkpoint.get('catalogId') != self.manifest['catalogId'] or checkpoint.get('installationId') != self.manifest['installationId'] or checkpoint.get('manifestHash') != self.manifest_hash:
            fail('CATALOG_CHECKPOINT_MISMATCH')
        seq = checkpoint.get('seq')
        if type(seq) is not int or seq < 0 or seq > len(self.entries):
            fail('CATALOG_ROLLBACK_DETECTED')
        head = self.entries[seq - 1]['hash'] if seq else self.manifest_hash
        if checkpoint.get('head') != head:
            fail('CATALOG_ROLLBACK_DETECTED')
        self.state()

    def advance(self, expected_epoch, recovery_id=None):
        epoch, _ = self.state()
        if recovery_id is not None:
            recovery_id = str(uuid.UUID(recovery_id))
            prior = [r['entry'] for r in self.entries if r['entry'].get('type') == 'epoch' and r['entry'].get('recoveryId') == recovery_id]
            if prior:
                if len(prior) != 1 or prior[0]['epoch'] != expected_epoch + 1 or epoch != expected_epoch + 1:
                    fail('CATALOG_RECOVERY_CONFLICT')
                return epoch
        if epoch != expected_epoch:
            fail('CATALOG_EPOCH_FENCED')
        event = {'type': 'epoch', 'epoch': epoch + 1}
        if recovery_id is not None: event['recoveryId'] = recovery_id
        self._append(event)
        return epoch + 1

    def begin(self, epoch, kind, authority, operation, request_digest, identity):
        current, pending = self.state()
        if current != epoch:
            fail('CATALOG_EPOCH_FENCED')
        matches = [a for a in self.manifest['authorities'] if a['kind'] == kind and a['id'] == authority]
        if not matches:
            fail('CATALOG_AUTHORITY_NOT_REGISTERED')
        if matches[0]['identity'] != identity:
            fail('CATALOG_AUTHORITY_IDENTITY_MISMATCH')
        seen = {row['entry'].get('operation') for row in self.entries if row['entry'].get('type') == 'pending'}
        if operation in seen or not isinstance(operation, str) or not operation or not isinstance(request_digest, str) or len(request_digest) != 64 or any(c not in '0123456789abcdef' for c in request_digest):
            fail('CATALOG_OPERATION_INVALID')
        self._append({'type': 'pending', 'epoch': epoch, 'kind': kind, 'authority': authority, 'operation': operation, 'requestDigest': request_digest})

    def close(self):
        os.close(self.fd)
        os.close(self.lockfd)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
