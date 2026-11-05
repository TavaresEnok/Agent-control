import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
import uuid
from unittest import mock

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'services/remote-worker'))
import resource_authority
spec = importlib.util.spec_from_file_location('remote_worker_recovery_test', root / 'services/remote-worker/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class RemoteRecoverySweepTest(unittest.TestCase):
    def test_late_old_epoch_request_is_refused_before_start(self):
        with tempfile.TemporaryDirectory(prefix='ac-t30-ssh-fence-') as tmp:
            operation = str(uuid.uuid4())
            request = {'schemaVersion': 1, 'action': 'start', 'operationId': operation, 'projectId': str(uuid.uuid4()),
                       'taskId': 'fixture', 'root': tmp, 'epoch': 1, 'recoveryEpoch': 1}
            config = {'recoveryInventoryRequired': True, 'authorityEpoch': 2}
            with mock.patch.object(sys, 'stdin', type('Input', (), {'buffer': io.BytesIO(json.dumps(request).encode())})()):
                with self.assertRaisesRegex(ValueError, 'RECOVERY_REMOTE_EPOCH_FENCED'):
                    worker.dispatch('/unused', config, pathlib.Path(tmp))
            request['recoveryEpoch'] = 2
            request['recoveryBinding'] = {'authorityId':'wrong'}
            config.update(installationId='fixture',resourceAuthority={'authorityId':'actual','anchorId':'a'*64})
            with mock.patch.object(sys, 'stdin', type('Input', (), {'buffer': io.BytesIO(json.dumps(request).encode())})()):
                with self.assertRaisesRegex(ValueError, 'RECOVERY_PHYSICAL_IDENTITY_MISMATCH'):
                    worker.dispatch('/unused', config, pathlib.Path(tmp))

    def test_unfinished_journal_and_unknown_group_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='ac-t30-ssh-') as tmp:
            path = pathlib.Path(tmp)
            operation = str(uuid.uuid4())
            request = {'schemaVersion': 1, 'action': 'recovery-sweep', 'operationId': str(uuid.uuid4()), 'recoveryToken': str(uuid.uuid4())}
            config = {'executionBackend': 'docker', 'installationId': 'synthetic', 'authorityEpoch': 2, 'recoveryInventoryRequired': True,
                      'resourceAuthority': {'authorityId': 'fixture', 'anchorId': 'a' * 64}}
            (path / (operation + '.json')).write_text(json.dumps({'operationId': operation, 'state': 'uncertain'}))
            def call():
                with mock.patch.object(sys, 'stdin', type('Input', (), {'buffer': io.BytesIO(json.dumps(request).encode())})()):
                    return worker.dispatch('/unused', config, path)
            with mock.patch.object(worker.remote_supervisor, 'recover', side_effect=lambda _c, _r, item, _a: item), \
                 mock.patch.object(resource_authority, '_reservation_paths', return_value=[]), \
                 mock.patch.object(resource_authority, 'docker', return_value='a' * 64):
                with self.assertRaisesRegex(ValueError, 'RECOVERY_REMOTE_INVENTORY_UNCERTAIN'):
                    call()
                (path / (operation + '.json')).write_text(json.dumps({'operationId': operation, 'state': 'failed', 'groupRemovalConfirmed': True}))
                self.assertEqual(call()['operations'], [operation])
                with mock.patch.object(resource_authority, 'docker', return_value='b' * 64):
                    with self.assertRaisesRegex(ValueError, 'RECOVERY_REMOTE_INVENTORY_UNCERTAIN'):
                        call()


if __name__ == '__main__':
    unittest.main()
