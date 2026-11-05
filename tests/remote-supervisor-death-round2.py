"""Run only as fixture UID inside the disposable ssh-host-a container."""
import json, subprocess, uuid, time, pathlib, os, signal
config='/fixtures/host-a/worker.json'
c=json.loads(pathlib.Path(config).read_text()); op=str(uuid.uuid4())
project=next(iter(c['projects'])); worker='/usr/local/lib/agent-control/worker.py'
assert c['stateDirectory'] in ('/projects/journal','/projects/aggregate-journal','/projects/aggregate-journal-2') and c['projects'][project]=='/projects/repo'
def rpc(req):
    p=subprocess.run(['python3',worker,'--config',config],input=json.dumps(req),text=True,capture_output=True,check=True)
    return json.loads(p.stdout)
rpc(dict(schemaVersion=1,action='start',operationId=op,projectId=project,taskId='slow',root='/projects/repo',epoch=1))
for _ in range(100):
    item=rpc(dict(schemaVersion=1,action='inspect',operationId=op))
    if item['state']=='running': break
    time.sleep(.02)
assert item['state']=='running'
supervisors=[]
for p in pathlib.Path('/proc').iterdir():
    if not p.name.isdigit(): continue
    try: cmd=(p/'cmdline').read_bytes().split(b'\0')
    except OSError: continue
    if b'--execute' in cmd and op.encode() in cmd: supervisors.append(int(p.name))
assert len(supervisors)==1,supervisors
os.kill(supervisors[0],signal.SIGKILL)
time.sleep(.1)
# Corrupt origin evidence in the private fixture journal: neither mismatch may
# authorize signaling the live child or a fabricated terminal receipt.
record=pathlib.Path(c['stateDirectory'])/(op+'.json')
original=json.loads(record.read_text()); assert original['origin']['pidNamespace']==original['pidNamespace']
for change in ({'pidNamespace':'pid:[999999999]'}, {'startTime':'0'}):
    record.write_text(json.dumps({**original,**change}))
    mismatch=rpc(dict(schemaVersion=1,action='inspect',operationId=op))
    assert mismatch['state']=='uncertain',mismatch
    mismatch=rpc(dict(schemaVersion=1,action='cancel',operationId=op,projectId=project,taskId='slow',epoch=1))
    assert mismatch['state']!='canceled_confirmed'
    os.kill(original['pid'],0)
record.write_text(json.dumps(original))
res=rpc(dict(schemaVersion=1,action='cancel',operationId=op,projectId=project,taskId='slow',epoch=1))
assert res['state']!='canceled_confirmed'
time.sleep(2.2)
res=rpc(dict(schemaVersion=1,action='inspect',operationId=op))
assert res['state']=='uncertain',res
if c.get('maxConcurrent') == 1:
    try:
        rpc(dict(schemaVersion=1,action='start',operationId=str(uuid.uuid4()),projectId=project,taskId='slow',root='/projects/repo',epoch=1))
    except subprocess.CalledProcessError:
        pass
    else:
        raise AssertionError('uncertain orphan released its capacity')
print('Synthetic supervisor SIGKILL: cancellation not confirmed; inspection remains uncertain after child exit.')
