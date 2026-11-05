import contextlib
import importlib.util
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'services/remote-worker'))
spec = importlib.util.spec_from_file_location('native_resource_bridge_test', root / 'services/remote-worker/native_resource_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class NativeRecoverySweepTest(unittest.TestCase):
    def test_interrupted_sweep_never_becomes_empty_success(self):
        config = {'installationId': 'fixture', 'authorityEpoch': 2, 'resourceAuthority': {'authorityId': 'ac-r3-resources-fixture', 'anchorId': 'a' * 64}}
        token = '17c6e027-0842-47da-9de0-c69114df4761'
        request = {'authority': config, 'stateRoot': '/fixture', 'action': 'recovery_sweep', 'recoveryToken': token}
        anchor = {'Config': {'Labels': {'ac.r3.disposable': 'true'}}}
        with tempfile.TemporaryDirectory(prefix='ac-t30-sweep-') as tmp, \
             mock.patch.object(bridge, 'serialized_authority', lambda _: contextlib.nullcontext()), \
             mock.patch.object(bridge, 'verify', return_value=({'authorityId': config['resourceAuthority']['authorityId'], 'anchorId': 'a' * 64}, 'fixture.slice')), \
             mock.patch.object(bridge, 'inspect', return_value=anchor), \
             mock.patch.object(bridge, '_reservation_paths', return_value=[]), \
             mock.patch.object(bridge, 'ledger_path', return_value=pathlib.Path(tmp) / 'authority'), \
             mock.patch.object(bridge, 'rpc', side_effect=[(200, []), RuntimeError('SYNTHETIC_CRASH')]) as rpc:
            with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_CRASH'):
                bridge.execute(request)
            rpc.side_effect = None
            rpc.return_value = (200, [])
            with self.assertRaisesRegex(ValueError, 'RECOVERY_RESOURCE_INVENTORY_UNCERTAIN'):
                bridge.execute(request)

    def test_pending_create_or_unknown_group_fails_without_neutralizing(self):
        config = {'installationId': 'fixture', 'authorityEpoch': 2, 'resourceAuthority': {'authorityId': 'ac-r3-resources-fixture', 'anchorId': 'a' * 64}}
        request = {'authority': config, 'stateRoot': '/fixture', 'action': 'recovery_sweep', 'recoveryToken': '17c6e027-0842-47da-9de0-c69114df4761'}
        anchor = {'Config': {'Labels': {'ac.r3.disposable': 'true'}}}
        with mock.patch.object(bridge, 'serialized_authority', lambda _: contextlib.nullcontext()), \
             mock.patch.object(bridge, 'verify', return_value=({'authorityId': config['resourceAuthority']['authorityId'], 'anchorId': 'a' * 64}, 'fixture.slice')), \
             mock.patch.object(bridge, 'inspect', return_value=anchor), \
             mock.patch.object(bridge, '_reservation_paths', return_value=['slot']), \
             mock.patch.object(bridge, '_read_reservation', return_value={'stateRoot': '/fixture', 'containerId': None}), \
             mock.patch.object(bridge, 'rpc') as rpc:
            with self.assertRaisesRegex(ValueError, 'RECOVERY_RESOURCE_INVENTORY_UNCERTAIN'):
                bridge.execute(request)
            rpc.assert_not_called()


if __name__ == '__main__':
    unittest.main()
