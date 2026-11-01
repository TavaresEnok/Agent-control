import importlib.util
import copy
import json
import tempfile
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

PATH = os.path.join(os.path.dirname(__file__), '..', 'supervisor.py')
spec = importlib.util.spec_from_file_location('remote_supervisor', PATH)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.intent = {'operation_id': 'op', 'company_id': 1, 'environment_id': 2, 'task_id': 3,
                       'execution_id': 4, 'epoch': '1', 'intent_hash': 'a' * 64}
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = os.path.join(self.directory.name, 'terminal.json')
        self.key = b'k' * 32

    def result(self, fields):
        return SimpleNamespace(returncode=0, stdout='\n'.join(k + '=' + v for k, v in fields.items()))

    def fields(self):
        return {'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running',
                'InvocationID': 'b' * 32, 'Description': 'agent-control-' + 'a' * 64,
                'Type': 'exec', 'KillMode': 'control-group', 'ControlGroup': '/user.slice/fixture', 'MainPID': '42'}

    def test_no_supervisor_evidence_is_uncertain(self):
        with patch.object(supervisor, 'call', return_value=self.result({'MainPID': '42'})):
            self.assertEqual('uncertain', supervisor.status('unit.service', self.intent, {})['state'])

    def test_running_requires_unit_identity_and_cgroup_supervision(self):
        fields = self.fields()
        with patch.object(supervisor, 'call', return_value=self.result(fields)):
            self.assertEqual('running', supervisor.status('unit.service', self.intent, {})['state'])
        fields['KillMode'] = 'process'
        with patch.object(supervisor, 'call', return_value=self.result(fields)):
            self.assertEqual('uncertain', supervisor.status('unit.service', self.intent, {})['state'])

    def test_wrapper_verification_failure_is_uncertain(self):
        fields = self.fields()
        fields.update({'ActiveState': 'active', 'SubState': 'exited', 'Result': 'exit-code', 'ExecMainStatus': '125'})
        with patch.object(supervisor, 'call', return_value=self.result(fields)):
            self.assertEqual('uncertain', supervisor.status('unit.service', self.intent, {})['state'])

    def test_completed_requires_systemd_terminal_evidence(self):
        fields = self.fields()
        fields.update({'ActiveState': 'active', 'SubState': 'exited', 'Result': 'success', 'ExecMainStatus': '0'})
        with patch.object(supervisor, 'call', return_value=self.result(fields)):
            receipt = supervisor.status('unit.service', self.intent, {})
            self.assertEqual('completed', receipt['state'])
            self.assertEqual(0, receipt['exit_code'])
        fields['InvocationID'] = '0' * 32
        with patch.object(supervisor, 'call', return_value=self.result(fields)):
            self.assertEqual('uncertain', supervisor.status('unit.service', self.intent, {})['state'])

    def terminal(self, failed=False):
        fields = self.fields()
        fields.update({'ActiveState': 'active', 'SubState': 'exited',
                       'Result': 'exit-code' if failed else 'success',
                       'ExecMainStatus': '7' if failed else '0'})
        with patch.object(supervisor, 'call', return_value=self.result(fields)):
            return supervisor.status('unit.service', self.intent, {})

    def observe(self, action='status', intent=None, unit='unit.service'):
        return supervisor.observe_operation(action, unit, intent or self.intent, {}, self.cache, os.geteuid(), self.key)

    def test_terminal_receipt_is_fsynced_private_and_survives_manager_loss(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                receipt = self.terminal(failed=failed)
                with patch.object(supervisor, 'status', return_value=receipt), patch.object(supervisor.os, 'fsync', wraps=os.fsync) as fsync:
                    self.assertEqual(receipt, self.observe())
                    self.assertGreaterEqual(fsync.call_count, 2)
                self.assertEqual(0o600, os.stat(self.cache).st_mode & 0o777)
                # No systemd query, stop or spawn is permitted after terminal cache.
                with patch.object(supervisor, 'call', side_effect=AssertionError('manager unavailable')), patch.object(supervisor, 'status', side_effect=AssertionError('unit disappeared')):
                    for action in ('status', 'cancel', 'dispatch'):
                        self.assertEqual(receipt, self.observe(action))
                os.unlink(self.cache)

    def test_running_and_uncertain_observations_are_never_cached(self):
        for fields in (self.fields(), {'LoadState': 'not-found'}):
            with patch.object(supervisor, 'call', return_value=self.result(fields)):
                self.assertIn(self.observe()['state'], ('running', 'uncertain'))
            self.assertFalse(os.path.exists(self.cache))

    def test_missing_unit_without_cached_terminal_stays_uncertain(self):
        with patch.object(supervisor, 'call', return_value=self.result({'LoadState': 'not-found'})):
            self.assertEqual('uncertain', self.observe('dispatch')['state'])
        self.assertFalse(os.path.exists(self.cache))

    def test_cancel_caches_only_the_verified_post_stop_terminal(self):
        running = dict(self.intent, remote_job_id='unit.service', state='running')
        terminal = self.terminal(failed=True)
        with patch.object(supervisor, 'status', side_effect=[running, terminal]), patch.object(supervisor, 'call') as stop:
            self.assertEqual(terminal, self.observe('cancel'))
            stop.assert_called_once_with(['/usr/bin/systemctl', '--user', 'stop', 'unit.service'], {})
        self.assertEqual(terminal, supervisor.read_terminal_cache(self.cache, os.geteuid(), self.key, 'unit.service', self.intent))

    def test_cache_rejects_changed_identity_unit_hash_outcome_and_invocation(self):
        receipt = self.terminal()
        for changes in ({'epoch': '2'}, {'company_id': 99}, {'remote_job_id': 'other.service'},
                        {'intent_hash': 'c' * 64}, {'exit_code': 1}, {'exit_code': True},
                        {'exit_code': 125}, {'invocation_id': '0' * 32}, {'state': 'running'}):
            with self.subTest(changes=changes):
                invalid = dict(receipt, **changes)
                with self.assertRaises(ValueError):
                    supervisor.write_terminal_cache(self.cache, os.geteuid(), self.key, 'unit.service', self.intent, invalid)
                self.assertFalse(os.path.exists(self.cache))

    def test_tampering_or_public_permissions_never_returns_cached_completion(self):
        receipt = self.terminal()
        supervisor.write_terminal_cache(self.cache, os.geteuid(), self.key, 'unit.service', self.intent, receipt)
        with open(self.cache, encoding='utf-8') as source:
            envelope = json.load(source)
        corrupted = copy.deepcopy(envelope)
        corrupted['receipt']['epoch'] = '2'
        supervisor.atomic_json(self.cache, corrupted)
        with self.assertRaises(ValueError):
            self.observe()
        supervisor.atomic_json(self.cache, envelope)
        os.chmod(self.cache, 0o644)
        with self.assertRaises(ValueError):
            self.observe()

    def test_terminal_cache_is_immutable_and_fsync_failure_is_not_a_receipt(self):
        receipt = self.terminal()
        with patch.object(supervisor, 'status', return_value=receipt), patch.object(supervisor, 'atomic_json', side_effect=OSError('disk failed')):
            with self.assertRaises(OSError):
                self.observe()
        self.assertFalse(os.path.exists(self.cache))
        supervisor.write_terminal_cache(self.cache, os.geteuid(), self.key, 'unit.service', self.intent, receipt)
        changed = dict(receipt, invocation_id='c' * 32)
        with self.assertRaises(ValueError):
            supervisor.write_terminal_cache(self.cache, os.geteuid(), self.key, 'unit.service', self.intent, changed)
        self.assertEqual(receipt, self.observe())


if __name__ == '__main__':
    unittest.main()
