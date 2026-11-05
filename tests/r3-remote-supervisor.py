"""Finite synthetic SSH/Docker proof; creates/removes only this invocation's resources."""
import json, os, pathlib, subprocess, tempfile, time, uuid

REPO = pathlib.Path(__file__).resolve().parents[1]

def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=30, **kwargs)

def until(fn):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError('finite wait expired')

with tempfile.TemporaryDirectory(prefix='ac-r3-remote-') as directory:
    lab = pathlib.Path(directory)
    project = lab / 'project'; project.mkdir(); project.chmod(0o777)
    run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(lab / 'client'))
    run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(lab / 'host'))
    (lab / 'authorized_keys').write_text((lab / 'client.pub').read_text())
    (lab / 'sshd_config').write_text(f'''Port 22
ListenAddress 0.0.0.0
HostKey {lab}/host
AuthorizedKeysFile {lab}/authorized_keys
StrictModes no
PermitRootLogin yes
PasswordAuthentication no
PubkeyAuthentication yes
UsePAM no
PidFile /tmp/sshd-r3.pid
''')
    task = "import os,subprocess,time;subprocess.Popen(['/usr/bin/python3','-c',\"import os,time;os.setsid();f=open('/project/writes','a',buffering=1);\\nwhile True:f.write('x\\\\n');time.sleep(.03)\"]);print('started',flush=True);time.sleep(60)"
    config = {'stateDirectory': str(lab / 'state'), 'projects': {'fixture': str(project)},
              'tasks': {'slow': ['/usr/bin/python3', '-c', task]}, 'maxSeconds': 60, 'maxLogBytes': 4096,
              'executionBackend': 'docker', 'installationId': 'ac-r3-remote-' + uuid.uuid4().hex,
              'authorityEpoch': 1, 'dockerImage': 'agent-control-ssh-lab:0.1.0'}
    config_path = lab / 'config.json'; config_path.write_text(json.dumps(config))
    name = 'ac-r3-remote-ssh-' + uuid.uuid4().hex[:10]
    server = run('docker', 'run', '-d', '--name', name, '--label', 'ac.r3.disposable=remote',
                 '-u', '0:0', '-p', '127.0.0.1::22', '-v', '/var/run/docker.sock:/var/run/docker.sock',
                 '-v', f'{lab}:{lab}', '-v', f'{REPO / "services/remote-worker"}:/usr/local/lib/agent-control:ro',
                 '--entrypoint', '/bin/sh', 'ac-r3-remote-ssh:20261105', '-ec',
                 f'mkdir -p /run/sshd; exec /usr/sbin/sshd -D -e -f {lab}/sshd_config').stdout.strip()
    try:
        port = json.loads(run('docker', 'inspect', server).stdout)[0]['NetworkSettings']['Ports']['22/tcp'][0]['HostPort']
        ssh = ['ssh', '-i', str(lab / 'client'), '-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2',
               '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + str(lab / 'known_hosts'), 'root@127.0.0.1']
        until(lambda: subprocess.run([*ssh, 'true'], capture_output=True, timeout=4).returncode == 0)
        def rpc(request, path=config_path, check=True):
            result = subprocess.run([*ssh, 'python3', '/usr/local/lib/agent-control/worker.py', '--config', str(path)],
                                    input=json.dumps(request), text=True, capture_output=True, timeout=30)
            if check:
                assert result.returncode == 0, result.stderr + result.stdout
            return json.loads(result.stdout), result.returncode
        operation = str(uuid.uuid4())
        start = dict(schemaVersion=1, action='start', operationId=operation, projectId='fixture', taskId='slow', root=str(project), epoch=7)
        rpc(start)  # discard ACK
        rpc(start)  # replay cannot create another group
        inspect = dict(schemaVersion=1, action='inspect', operationId=operation)
        item = until(lambda: (lambda i: i if i.get('stableGroup') else None)(rpc(inspect)[0]))
        until(lambda: (project / 'writes').exists() and (project / 'writes').stat().st_size > 5)
        group = item['stableGroup']['id']
        identity = json.loads(run('docker', 'inspect', group).stdout)[0]
        assert identity['State']['Running'] and identity['Id'] == group
        # Kill only the identified supervisor in this invocation's SSH namespace.
        run(*ssh, 'kill', '-9', str(item['origin']['supervisorPid']))
        before = (project / 'writes').stat().st_size
        time.sleep(.2)
        assert (project / 'writes').stat().st_size > before, 'descendant did not survive supervisor death'
        # Successor authority advances. Old configuration is fenced before any RPC.
        old = lab / 'old.json'; old.write_text(json.dumps(config))
        config['authorityEpoch'] = 2; config_path.write_text(json.dumps(config))
        cancel = {**start, 'action': 'cancel'}; del cancel['root']
        result, _ = rpc(cancel)  # lose this ACK too
        assert result['state'] == 'canceled_confirmed' and result['groupRemovalConfirmed'], result
        assert result['recoveredSupervisor']
        stable = (project / 'writes').stat().st_size
        time.sleep(.25)
        assert (project / 'writes').stat().st_size == stable
        assert subprocess.run(['docker', 'inspect', group], capture_output=True).returncode != 0
        replay, _ = rpc(start)
        assert replay['state'] == 'canceled_confirmed' and replay['stableGroup']['id'] == group
        assert rpc(inspect)[0]['logSha256'] == result['logSha256']
        assert rpc(inspect, old, check=False)[1] != 0
        print('PASS SSH supervisor SIGKILL, setsid writer stopped by successor immutable group removal, epoch fence, lost ACK replay')
        second = str(uuid.uuid4())
        rpc({**start, 'operationId': second})
        second_inspect = {**inspect, 'operationId': second}
        second_item = until(lambda: (lambda i: i if i.get('stableGroup') else None)(rpc(second_inspect)[0]))
        run(*ssh, 'kill', '-9', str(second_item['origin']['supervisorPid']))
        # Inject ACK loss after a REAL Docker removal, before terminal journal commit.
        fault = """import sys,json,subprocess
sys.path.insert(0,'/usr/local/lib/agent-control')
import worker,remote_supervisor as supervisor
config,root=worker.load(sys.argv[1]);item=json.loads((root/(sys.argv[2]+'.json')).read_text())
original=supervisor.docker
def lost(*args,**kwargs):
 result=original(*args,**kwargs)
 if args[0]=='rm':raise subprocess.TimeoutExpired('lost-removal-ack',1)
 return result
supervisor.docker=lost
result=supervisor.recover(config,root,item,worker.atomic)
assert result['state']=='uncertain',result
print('lost-removal-ack retained uncertainty')
"""
        assert 'retained uncertainty' in run('docker', 'exec', server, 'python3', '-c', fault, str(config_path), second).stdout
        assert subprocess.run(['docker', 'inspect', second_item['stableGroup']['id']], capture_output=True).returncode != 0
        replay_removed = rpc(second_inspect)[0]
        assert replay_removed['state'] == 'failed' and replay_removed['groupRemovalConfirmed'], replay_removed
        assert replay_removed['logSha256']
        print('PASS real removal with lost ACK retains uncertainty, successor replays durable log receipt after absence')
        # Interrupted create without immutable ID cannot be declared absent: daemon may finish later.
        pending = str(uuid.uuid4())
        pending_item = {**second_item, 'operationId': pending, 'state': 'uncertain'}
        del pending_item['stableGroup']
        pending_item['groupIntent'] = {**pending_item['groupIntent'], 'ac.remote.operation': pending}
        pending_path = str(lab / 'state' / (pending + '.json'))
        run('docker', 'exec', '-i', server, 'python3', '-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.stdin.read())', pending_path, input=json.dumps(pending_item))
        assert rpc({**inspect, 'operationId': pending})[0]['state'] == 'uncertain'
        print('PASS interrupted create without immutable ID stays uncertain despite empty Docker enumeration')
        # A fabricated immutable ID / labels must fail closed without touching another group.
        record_path = str(lab / 'state' / (operation + '.json'))
        original = json.loads(run('docker', 'exec', server, 'cat', record_path).stdout)
        original['state'] = 'running'; original['stableGroup']['id'] = server
        run('docker', 'exec', '-i', server, 'python3', '-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.stdin.read())', record_path, input=json.dumps(original))
        assert rpc(inspect)[0]['state'] == 'uncertain'
        assert json.loads(run('docker', 'inspect', server).stdout)[0]['State']['Running']
        print('PASS identity mismatch fails closed; unrelated SSH container preserved')
    finally:
        # Exact label+installation ownership check before cleanup, never global prune.
        groups = run('docker', 'ps', '-aq', '--no-trunc', '--filter', 'label=ac.remote.installation=' + config['installationId']).stdout.split()
        for identity in groups:
            run('docker', 'rm', '-f', identity)
        run('docker', 'exec', server, 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(lab))
        run('docker', 'rm', '-f', server)
