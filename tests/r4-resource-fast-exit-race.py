#!/usr/bin/env python3
"""Deterministic local-filesystem race proof, no Docker, accounts or skips.
The inspection/authority boundary is injected; kernel-file removal/empty reads
are real files. The combined flow separately exercises Docker/cgroups.
"""
import contextlib
import copy
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
import json
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/remote-worker'))
import resource_authority as resource
import native_resource_bridge as bridge
import remote_supervisor as remote

ID = 'a' * 64
OP = '00000000-0000-4000-8000-000000000001'
CONFIG = {'resourceAuthority': {'authorityId': 'ac-r3-resources-race'}}
PARENT = 'fixture.slice'
RUNNING = {'Id': ID, 'Name': '/ac-native-qa-' + OP, 'Image': 'sha256:' + 'b' * 64,
           'Config': {'Labels': {resource.LABEL: CONFIG['resourceAuthority']['authorityId'], 'ac.resources.operation': OP, 'ac.resources.epoch': '1', 'ac.resources.request': 'c' * 64}},
           'HostConfig': {'CgroupParent': PARENT}, 'RestartCount': 0,
           'State': {'Running': True, 'Restarting': False, 'Dead': False, 'Paused': False, 'Status': 'running', 'Pid': 12345,
                     'StartedAt': '2026-11-05T12:00:00.123456789Z', 'FinishedAt': '0001-01-01T00:00:00Z', 'ExitCode': 0}}
TERMINAL = copy.deepcopy(RUNNING)
TERMINAL['State'].update(Running=False, Status='exited', Pid=0, FinishedAt='2026-11-05T12:00:00.223456789Z')


class FastExitRace(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory(prefix='ac-r4-fast-exit-')
        self.root = pathlib.Path(self.area.name)
        self.group = self.root / ('docker-' + ID + '.scope')
        self.group.mkdir()
        self.procs = self.group / 'cgroup.procs'
        self.procs.write_text('12345\n')
        self.read_processes = resource._group_processes
        self.calls = []

    def tearDown(self):
        self.area.cleanup()

    def remove_group(self):
        if self.procs.exists(): self.procs.unlink()
        if self.group.exists(): self.group.rmdir()

    def observe(self, current, race='absent'):
        def verify(_):
            if race == 'absent': self.remove_group()
            elif race == 'empty': self.procs.write_text('')
            elif race == 'occupied': self.procs.write_text('99999\n')
            return CONFIG['resourceAuthority'], PARENT

        def reinspect(identifier):
            self.calls.append(identifier)
            return copy.deepcopy(current)

        with patch.object(resource, 'verify', verify), patch.object(resource, '_group_processes', lambda _root, inspected: self.read_processes(self.root, inspected)):
            return resource._validate_group(CONFIG, copy.deepcopy(RUNNING), reinspect)

    def test_running_snapshot_then_group_deleted_is_reproduced_and_terminal_exact_id_recovers(self):
        self.remove_group()
        with self.assertRaises(FileNotFoundError): resource._physical_member(self.root, RUNNING)
        self.assertEqual(self.observe(TERMINAL), TERMINAL)
        self.assertEqual(self.calls, [ID])
        self.assertTrue(RUNNING['State']['Running'], 'input snapshot is never rewritten')

    def test_empty_group_after_exit_is_accepted_without_any_capacity_release(self):
        self.assertEqual(self.observe(TERMINAL, 'empty'), TERMINAL)
        self.assertEqual(self.calls, [ID])

    def test_running_reobservation_requires_kernel_pid_membership_again(self):
        def reinspect(identifier):
            self.calls.append(identifier)
            self.procs.write_text('12345\n')
            return copy.deepcopy(RUNNING)
        with patch.object(resource, 'verify', return_value=(CONFIG['resourceAuthority'], PARENT)), patch.object(resource, '_group_processes', lambda _root, inspected: self.read_processes(self.root, inspected)):
            self.procs.write_text('')
            self.assertEqual(resource._validate_group(CONFIG, RUNNING, reinspect), RUNNING)
        with self.assertRaisesRegex(ValueError, 'RESOURCE_PHYSICAL_GROUP_UNCERTAIN'): self.observe(RUNNING)
        self.assertEqual(self.calls, [ID, ID])

    def test_absence_and_identity_substitution_never_become_terminal_proof(self):
        mutations = [None]
        for key, value in [('Id', 'd' * 64), ('Name', '/reused-name'), ('Image', 'sha256:' + 'd' * 64), ('RestartCount', 1)]:
            current = copy.deepcopy(TERMINAL);current[key] = value;mutations.append(current)
        for label in [resource.LABEL, 'ac.resources.operation', 'ac.resources.epoch', 'ac.resources.request']:
            current = copy.deepcopy(TERMINAL);current['Config']['Labels'][label] = 'different';mutations.append(current)
        current = copy.deepcopy(TERMINAL);current['HostConfig']['CgroupParent'] = 'other.slice';mutations.append(current)
        for current in mutations:
            with self.subTest(current=current), self.assertRaisesRegex(ValueError, 'RESOURCE_GROUP_REOBSERVATION_MISMATCH'):
                self.observe(current)
        self.assertTrue(all(value == ID for value in self.calls), 'no reinspection uses a reusable name')

    def test_restart_and_every_unproven_terminal_state_remain_uncertain(self):
        changes = [dict(StartedAt='2026-11-05T12:00:00.133456789Z'), dict(Status='created'), dict(Status='dead'), dict(Status='removing'),
                   dict(Restarting=True), dict(Dead=True), dict(Paused=True), dict(Pid=42), dict(Pid=False), dict(ExitCode=False),
                   dict(FinishedAt='0001-01-01T00:00:00Z'), dict(FinishedAt='invalid'), dict(FinishedAt='2026-11-05T11:00:00Z'), dict(FinishedAt='2026-11-05T12:00:00.123456788Z')]
        for change in changes:
            current = copy.deepcopy(TERMINAL);current['State'].update(change)
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'RESOURCE_GROUP_RESTARTED|RESOURCE_GROUP_TERMINAL_UNCONFIRMED'):
                self.observe(current)

    def test_exited_docker_group_with_remaining_kernel_process_is_not_accepted(self):
        with self.assertRaisesRegex(ValueError, 'RESOURCE_TERMINAL_GROUP_OCCUPIED'): self.observe(TERMINAL, 'occupied')

    def test_missing_parent_cgroup_is_uncertain_even_when_docker_says_exited(self):
        self.remove_group();self.root.rmdir()
        with self.assertRaisesRegex(ValueError, 'RESOURCE_ENVELOPE_UNCERTAIN'): self.observe(TERMINAL)
        self.assertEqual(self.calls, [])

    def test_authority_anchor_failure_never_enters_worker_reobservation(self):
        with patch.object(resource, 'verify', side_effect=ValueError('RESOURCE_ANCHOR_MISMATCH')):
            with self.assertRaisesRegex(ValueError, 'RESOURCE_ANCHOR_MISMATCH'):
                resource._validate_group(CONFIG, RUNNING, lambda _: self.fail('anchor failure must not reobserve worker'))

    def test_validated_terminal_snapshot_binds_existing_slot_to_same_immutable_id(self):
        slot = {'operationId': OP, 'epoch': 1, 'containerId': None}
        writes = []
        with patch.object(resource, 'authority', lambda _: contextlib.nullcontext()), patch.object(resource, 'verify', return_value=(CONFIG['resourceAuthority'], PARENT)), patch.object(resource, '_group_processes', lambda _root, inspected: self.read_processes(self.root, inspected)), patch.object(resource, '_reservation_paths', return_value=['slot']), patch.object(resource, '_read_reservation', return_value=slot), patch.object(resource, '_write_reservation', side_effect=lambda path, value, create: writes.append((path, copy.deepcopy(value), create))):
            self.remove_group()
            self.assertEqual(resource.validate_group(CONFIG, RUNNING, OP, 1, lambda _: TERMINAL), TERMINAL)
            self.assertEqual(writes, [('slot', {'operationId': OP, 'epoch': 1, 'containerId': ID}, False)])
            slot['containerId'] = 'd' * 64
            with self.assertRaisesRegex(ValueError, 'RESOURCE_RESERVATION_ID_MISMATCH'): resource.validate_group(CONFIG, RUNNING, OP, 1, lambda _: TERMINAL)

    def test_remote_finish_receipt_uses_refreshed_exit_code_instead_of_stale_running_fallback(self):
        config = {**CONFIG, 'installationId': 'race-fixture', 'authorityEpoch': 1}
        item = {'operationId': OP, 'epoch': 1}
        item['stableGroup'] = {'id': ID, 'labels': remote.labels(config, item)}
        effects = []
        def docker(*args, **_):
            effects.append(args)
            if args[0] == 'logs': return SimpleNamespace(returncode=0, stdout=b'finished\n', stderr=b'')
            self.assertEqual(args, ('rm', '--force', ID));return SimpleNamespace(returncode=0)
        def atomic(path, value): path.write_text(json.dumps(value))
        self.remove_group()
        with patch.object(remote, 'inspect', side_effect=[copy.deepcopy(RUNNING), None]), patch.object(remote, 'docker', docker), patch.object(resource, 'authority', lambda _: contextlib.nullcontext()), patch.object(resource, 'verify', return_value=(CONFIG['resourceAuthority'], PARENT)), patch.object(resource, '_group_processes', lambda _root, inspected: self.read_processes(self.root, inspected)), patch.object(resource, '_inspect_immutable', side_effect=lambda identifier: copy.deepcopy(TERMINAL) if identifier == ID else self.fail('wrong identity')), patch.object(resource, '_reservation_paths', return_value=[]), patch.object(resource, 'release') as release:
            result = remote.finish(config, self.root, item, atomic)
            self.assertEqual(result['exitCode'], 0)
            self.assertEqual(result['state'], 'completed')
            self.assertEqual(json.loads((self.root / (OP + '.json')).read_text())['exitCode'], 0)
            self.assertEqual(effects[-1], ('rm', '--force', ID))
            release.assert_called_once_with(config, ID, OP, 1)

    def test_native_bridge_returns_reobserved_terminal_snapshot(self):
        config = {'installationId': 'race-fixture', '_stateRoot': str(self.root), 'resourceAuthority': {'authorityId': 'ac-r3-resources-race', 'anchorId': 'f' * 64}}
        physical = copy.deepcopy(RUNNING)
        op = bridge.operation(config, physical['Name'].removeprefix('/'))
        physical['Config']['Labels']['ac.resources.operation'] = op
        terminal = copy.deepcopy(physical);terminal['State'] = TERMINAL['State']
        claim = self.root / 'claim.json';claim.write_text('{}')
        def inspect(identifier):
            if identifier == 'f' * 64: return {'Config': {'Labels': {'ac.r3.disposable': 'true'}}}
            self.assertEqual(identifier, ID);return physical
        with patch.object(bridge, 'serialized_authority', lambda _: contextlib.nullcontext()), patch.object(bridge, 'verify', return_value=(config['resourceAuthority'], PARENT)), patch.object(bridge, 'inspect', inspect), patch.object(bridge, 'claim_path', return_value=claim), patch.object(bridge, 'claim_operation', return_value=False), patch.object(bridge, 'validate_group', return_value=terminal):
            result = bridge.execute({'action': 'inspect', 'authority': config, 'stateRoot': str(self.root), 'id': ID})
            self.assertEqual(result['physical'], terminal)
            self.assertFalse(result['physical']['State']['Running'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
