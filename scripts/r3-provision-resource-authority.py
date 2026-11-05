#!/usr/bin/env python3
"""Explicit disposable-lab provisioning; never called by the executor.
Uses one new labeled anchor and a unique new slice, not daemon configuration.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'services/remote-worker'))
from resource_authority import LABEL, docker, verify, policy_digest, ledger_path, installation_lock, _write_reservation

parser = argparse.ArgumentParser()
parser.add_argument('--lab-provision', action='store_true', required=True)
parser.add_argument('--authority', required=True)
parser.add_argument('--image', required=True)
parser.add_argument('--installation')
parser.add_argument('--output', required=True)
parser.add_argument('--cpu-quota', type=int, default=50000)
parser.add_argument('--memory', type=int, default=134217728)
parser.add_argument('--pids', type=int, default=32)
parser.add_argument('--jobs', type=int, default=2)
args = parser.parse_args()
if not args.authority.startswith('ac-r3-resources-'):
    raise SystemExit('LAB_AUTHORITY_PREFIX_REQUIRED')
output = pathlib.Path(args.output)
if output.exists():
    raise SystemExit('OUTPUT_EXISTS')
parent = 'acr' + hashlib.sha256(args.authority.encode()).hexdigest()[:24] + '.slice'
if pathlib.Path('/sys/fs/cgroup', parent).exists():
    raise SystemExit('CGROUP_ALREADY_EXISTS')
if docker('info', '--format', '{{.CgroupDriver}} {{.CgroupVersion}}') != 'systemd 2':
    raise SystemExit('RESOURCE_BACKEND_UNSUPPORTED')
directory = pathlib.Path('/var/tmp') / ('ac-resource-authority-' + str(os.geteuid()))
directory.mkdir(mode=0o700, exist_ok=True)
directory_info = directory.stat()
value = {'authorityId': args.authority, 'cpuQuotaMicros': args.cpu_quota,
         'cpuPeriodMicros': 100000, 'memoryBytes': args.memory, 'pidsLimit': args.pids, 'maxJobs': args.jobs}
config = {'installationId': args.installation or args.authority, 'authorityEpoch': 1, 'resourceAuthority': value}
with installation_lock(config, provision=True) as installation:
    binding_path = installation / 'binding.json'
    if binding_path.exists():
        raise SystemExit('RESOURCE_INSTALLATION_ALREADY_BOUND')
    if docker('ps', '-aq', '--filter', 'label=ac.resources.installation=' + config['installationId']):
        raise SystemExit('RESOURCE_INSTALLATION_GROUPS_EXIST')
    pending = {'installationId': config['installationId'], 'authorityId': args.authority,
               'anchorId': None, 'operationId': 'installation-binding'}
    # Exclusive durable intent precedes Docker creation; a lost create ACK leaves
    # the installation bound and uncertain, never available for another budget.
    _write_reservation(binding_path, pending, True)
    installation_info = installation.stat()
    anchor = docker('run', '-d', '--name', parent[:-6] + '-anchor', '--label', LABEL + '=' + args.authority,
                    '--label', 'ac.r3.disposable=true',
                    '--label', 'ac.resources.installation-directory=' + str(installation_info.st_dev) + ':' + str(installation_info.st_ino),
                    '--label', 'ac.resources.ledger-directory=' + str(directory_info.st_dev) + ':' + str(directory_info.st_ino),
                    '--label', 'ac.resources.uid=' + str(os.geteuid()),
                    '--label', 'ac.resources.max-jobs=' + str(args.jobs), '--label', 'ac.resources.policy=' + policy_digest(value),
                    '--label', 'ac.resources.installation=' + config['installationId'], '--cgroup-parent', parent,
                    '--entrypoint', 'sleep', args.image, 'infinity')
    value['anchorId'] = anchor
    code = """import pathlib,sys,json
p=pathlib.Path('/host-cgroup')/sys.argv[1]
v=json.loads(sys.argv[2])
for name,value in v.items(): (p/name).write_text(str(value))
"""
    limits = {'cpu.max': f'{args.cpu_quota} 100000', 'memory.max': args.memory, 'memory.swap.max': 0, 'pids.max': args.pids}
    try:
        docker('run', '--rm', '--user', '0', '--privileged', '--cgroupns', 'host', '--mount',
               'type=bind,source=/sys/fs/cgroup,target=/host-cgroup', '--entrypoint', 'python3', args.image,
               '-c', code, parent, json.dumps(limits))
        _write_reservation(binding_path, {**pending, 'anchorId': anchor}, False)
        verify(config)
        ledger = ledger_path(config)
        fd = os.open(ledger, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            encoded = json.dumps({'anchorId': anchor, 'installationId': config['installationId'], 'epoch': 1}, sort_keys=True).encode()
            if os.write(fd, encoded) != len(encoded): raise ValueError('SHORT_LEDGER_WRITE')
            os.fsync(fd)
        finally:
            os.close(fd)
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
        with output.open('x') as stream:
            json.dump(config, stream, indent=2)
        print(json.dumps({'authority': args.authority, 'anchorId': anchor, 'parent': parent}))
    except BaseException:
        docker('rm', '-f', anchor)
        # Binding survives failed provisioning; recovery cannot assume that all
        # daemon requests completed or recreate a second installation envelope.
        raise
