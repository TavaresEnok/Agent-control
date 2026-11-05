#!/usr/bin/env python3
"""Finite real Docker/cgroup proof. No skips or operational resources.
Run: python3 tests/r3-resource-authority-physical.py
"""
import concurrent.futures
import copy
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/remote-worker'))
from resource_authority import docker, reservation, verify, validate_group, release, ledger_path, claim_operation, authority as fenced_authority

image = os.environ.get('R3_RESOURCE_IMAGE', 'agent-control-ssh-lab:0.1.0')
authority = 'ac-r3-resources-' + uuid.uuid4().hex[:12]
containers = []
anchor = None
claim_paths = []
results = {}


def counters(path):
    return {key: int(value) for key, value in (line.split() for line in path.read_text().splitlines())}


def create(config, code, start=True):
    operation = str(uuid.uuid4())
    with reservation(config, operation, 1) as options:
        identifier = docker('create', *options, '--label', 'ac.r3.disposable=true', '--user', '0',
                            '--entrypoint', 'python3', image, '-c', code)
        containers.append(identifier)
    validate_group(config, json.loads(docker('inspect', identifier))[0], operation, 1)
    if start:
        docker('start', identifier)
    return identifier


def remove(identifier):
    docker('rm', '-f', identifier)
    containers.remove(identifier)
    release(config, identifier, 'test', 1)


def rejected(action, expected):
    try:
        action()
    except (ValueError, FileNotFoundError) as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError('Expected failure: ' + expected)


try:
    with tempfile.TemporaryDirectory(prefix='ac-r3-resources-') as temporary:
        config_path = pathlib.Path(temporary) / 'authority.json'
        subprocess.run([sys.executable, str(ROOT / 'scripts/r3-provision-resource-authority.py'),
                        '--lab-provision', '--authority', authority, '--image', image, '--output', str(config_path),
                        '--pids', '16'], check=True)
        config = json.loads(config_path.read_text())
        anchor = config['resourceAuthority']['anchorId']
        value, parent = verify(config)
        group = pathlib.Path('/sys/fs/cgroup') / parent
        # Independent controllers, different working/state directories, shared authority.
        child_code = """import json,pathlib,sys,time
sys.path.insert(0,sys.argv[1]); from resource_authority import reservation,docker
config=json.loads(pathlib.Path(sys.argv[2]).read_text())
for attempt in range(40):
 try:
  with reservation(config,sys.argv[3],1) as options:
   time.sleep(.1)
   identifier=docker('create',*options,'--label','ac.r3.disposable=true','--entrypoint','sleep',sys.argv[4],'60')
  print(json.dumps({'id':identifier})); break
 except ValueError as error:
  if str(error)=='RESOURCE_AUTHORITY_BUSY' and attempt<39: time.sleep(.05); continue
  print(json.dumps({'error':str(error)})); break
"""
        paths = []
        for index in range(8):
            directory = pathlib.Path(temporary) / str(index)
            directory.mkdir()
            path = directory / 'config.json'
            path.write_text(json.dumps({**config, 'stateDirectory': str(directory)}))
            paths.append(path)
        def contender(path):
            return json.loads(subprocess.check_output([sys.executable, '-c', child_code,
                str(ROOT / 'services/remote-worker'), str(path), str(uuid.uuid4()), image], cwd=path.parent, text=True))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            attempts = list(pool.map(contender, paths))
        winners = [row['id'] for row in attempts if 'id' in row]
        containers.extend(winners)
        assert len(winners) == 2, attempts
        assert all(row.get('error') in ('RESOURCE_AUTHORITY_BUSY', 'RESOURCE_CAPACITY_EXHAUSTED') for row in attempts if 'error' in row), attempts
        # Fill remaining slot. Created containers survived their controller exits.
        while len(containers) < 2:
            create(config, 'pass', start=False)
        rejected(lambda: create(config, 'pass'), 'RESOURCE_CAPACITY_EXHAUSTED')
        rejected(lambda: release(config, containers[0], 'test', 1), 'RESOURCE_GROUP_STILL_PRESENT')
        for identifier in list(containers): remove(identifier)
        results['crossDirectoryControllers'] = {'controllers': 8, 'admittedAtRace': len(winners), 'capacity': 2, 'orphanAndCreatedCounted': True}
        # CPU quota physically shared by two independent child cgroups.
        before = counters(group / 'cpu.stat')
        cpu = [create(config, 'import time\nend=time.monotonic()+3\nwhile time.monotonic()<end: pass') for _ in range(2)]
        for identifier in cpu: docker('wait', identifier)
        after = counters(group / 'cpu.stat')
        usage = after['usage_usec'] - before['usage_usec']
        throttled = after['nr_throttled'] - before['nr_throttled']
        assert throttled > 0 and usage < 2500000, (usage, throttled)
        results['cpu'] = {'quota': (group / 'cpu.max').read_text().strip(), 'combinedUsageMicros': usage, 'throttledPeriods': throttled}
        for identifier in cpu: remove(identifier)
        # Each child could fit alone; combined allocation exceeds the parent's memory.
        before = counters(group / 'memory.events')
        memory = [create(config, 'import time\ntime.sleep(1)\nx=bytearray(90*1024*1024)\ntime.sleep(2)') for _ in range(2)]
        exits = [int(docker('wait', identifier)) for identifier in memory]
        after = counters(group / 'memory.events')
        assert after['oom_kill'] > before['oom_kill'] and any(code != 0 for code in exits), (before, after, exits)
        results['memory'] = {'maximum': (group / 'memory.max').read_text().strip(), 'oomKills': after['oom_kill'] - before['oom_kill'], 'exitCodes': exits}
        for identifier in memory: remove(identifier)
        # Forking children in two child groups hits the shared PID budget.
        before = counters(group / 'pids.events')
        code = '''import os,time
time.sleep(1)
children=[]
for i in range(12):
 try:
  pid=os.fork()
  if pid==0: time.sleep(2); os._exit(0)
  children.append(pid)
 except OSError: break
for pid in children: os.waitpid(pid,0)
'''
        pids = [create(config, code) for _ in range(2)]
        for identifier in pids: docker('wait', identifier)
        after = counters(group / 'pids.events')
        assert after['max'] > before['max'], (before, after)
        results['pids'] = {'maximum': (group / 'pids.max').read_text().strip(), 'rejections': after['max'] - before['max']}
        for identifier in pids: remove(identifier)
        operation = str(uuid.uuid4())
        request_digest = hashlib.sha256(b'authorized request').hexdigest()
        assert claim_operation(config, operation, 1, request_digest, paths[0].parent) is True
        claim_key = hashlib.sha256((config['installationId'] + '\0' + operation).encode()).hexdigest()
        claim_paths.append(ledger_path(config).parent / ('operation-' + claim_key + '.json'))
        assert claim_operation(config, operation, 1, request_digest, paths[0].parent) is False
        rejected(lambda: claim_operation(config, operation, 1, request_digest, paths[1].parent), 'RESOURCE_OPERATION_ALREADY_CLAIMED')
        rejected(lambda: claim_operation(config, operation, 2, request_digest, paths[0].parent), 'RESOURCE_OPERATION_ALREADY_CLAIMED')
        rejected(lambda: claim_operation(config, operation, 1, '0' * 64, paths[0].parent), 'RESOURCE_OPERATION_ALREADY_CLAIMED')
        newer = {**config, 'authorityEpoch': 2}
        with fenced_authority(newer):
            with fenced_authority(newer): pass
        rejected(lambda: create(config, 'pass'), 'RESOURCE_AUTHORITY_FENCED')
        config = newer
        bad = copy.deepcopy(config)
        bad['resourceAuthority']['maxJobs'] += 1
        rejected(lambda: verify(bad), 'RESOURCE_ANCHOR_POLICY_MISMATCH')
        bad = {**config, 'resourceCgroupRoot': temporary}
        rejected(lambda: verify(bad), 'RESOURCE_CGROUP_ROOT_OVERRIDE_FORBIDDEN')
        bad = copy.deepcopy(config)
        bad['resourceAuthority']['memoryBytes'] *= 2
        rejected(lambda: verify(bad), 'RESOURCE_ANCHOR_POLICY_MISMATCH')
        def physical_cpu_limit(value):
            docker('run', '--rm', '--user', '0', '--privileged', '--cgroupns', 'host', '--mount',
                   'type=bind,source=/sys/fs/cgroup,target=/host-cgroup', '--entrypoint', 'python3', image,
                   '-c', 'import pathlib,sys;(pathlib.Path("/host-cgroup")/sys.argv[1]/"cpu.max").write_text(sys.argv[2])', parent, value)
        physical_cpu_limit('60000 100000')
        try:
            rejected(lambda: verify(config), 'RESOURCE_ENVELOPE_MISMATCH')
        finally:
            physical_cpu_limit('50000 100000')
        wrong = create(config, 'pass', start=False)
        inspect = json.loads(docker('inspect', wrong))[0]
        inspect['HostConfig']['CgroupParent'] = 'wrong.slice'
        rejected(lambda: validate_group(config, inspect, 'test', 1), 'RESOURCE_GROUP_MISMATCH')
        remove(wrong)
        recovered_operation = str(uuid.uuid4())
        try:
            with reservation(config, recovered_operation, 1) as options:
                recovered_id = docker('create', *options, '--label', 'ac.r3.disposable=true', '--entrypoint', 'sleep', image, '60')
                containers.append(recovered_id)
                raise TimeoutError('lost create ACK after real create')
        except TimeoutError: pass
        rejected(lambda: create(config, 'pass'), 'RESOURCE_CAPACITY_EXHAUSTED')
        validate_group(config, json.loads(docker('inspect', recovered_id))[0], recovered_operation, 1)
        remove(recovered_id)
        pending_operation = str(uuid.uuid4())
        try:
            with reservation(config, pending_operation, 1):
                raise TimeoutError('simulated create lost ACK before daemon response')
        except TimeoutError: pass
        # One uncertain intent + one created container exhaust the authority.
        remaining = create(config, 'pass', start=False)
        rejected(lambda: create(config, 'pass'), 'RESOURCE_CAPACITY_EXHAUSTED')
        remove(remaining)
        ledger = ledger_path(config)
        saved = ledger.read_bytes()
        ledger.unlink()
        rejected(lambda: create(config, 'pass'), 'RESOURCE_AUTHORITY_LEDGER_MISSING')
        with ledger.open('xb') as stream:
            os.chmod(ledger, 0o600)
            stream.write(b'')
        rejected(lambda: create(config, 'pass'), 'RESOURCE_AUTHORITY_LEDGER_UNCERTAIN')
        ledger.write_bytes(saved)
        docker('stop', '-t', '1', anchor)
        rejected(lambda: verify(config), 'RESOURCE_ANCHOR_MISMATCH')
        results['failureMatrix'] = ['busy shared authority', 'cross-directory old authority fenced', 'durable operation same-root replay', 'cross-root operation conflict', 'operation epoch/digest conflict', 'nested authority admission', 'created/orphan capacity full', 'release while present', 'changed physical envelope', 'changed maxJobs policy', 'fake cgroup root', 'missing persistent epoch ledger', 'empty recreated ledger', 'pending create timeout retains capacity', 'real create lost ACK recovered binding', 'wrong physical parent', 'stopped anchor']
        print(json.dumps({'passed': True, 'results': results}, indent=2))
finally:
    # IDs originated only in this unique labeled disposable authority.
    for identifier in containers + ([anchor] if anchor else []):
        info = json.loads(docker('inspect', identifier))[0]
        assert info['Config']['Labels'].get('ac.resources.authority') == authority
        docker('rm', '-f', identifier)

    if anchor is not None:
        prefix = hashlib.sha256(config['resourceAuthority']['authorityId'].encode()).hexdigest()[:24]
        for path in ledger_path(config).parent.glob('reservation-' + prefix + '-*.json'):
            path.unlink()
    for path in claim_paths:
        path.unlink()
    if anchor is not None:
        ledger_path(config).unlink(missing_ok=True)
