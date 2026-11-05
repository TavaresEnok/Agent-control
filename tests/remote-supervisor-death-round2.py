"""Run only as fixture UID inside the disposable ssh-host-a container."""
import json, subprocess, uuid, time, pathlib, os, signal
config='/fixtures/host-a/worker.json'
c=json.loads(pathlib.Path(config).read_text()); op=str(uuid.uuid4())
project=next(iter(c['projects'])); worker='/usr/local/lib/agent-control/worker.py'
assert c['stateDirectory']=='/projects/journal' and c['projects'][project]=='/projects/repo'
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
res=rpc(dict(schemaVersion=1,action='cancel',operationId=op,projectId=project,taskId='slow',epoch=1))
assert res['state']!='canceled_confirmed'
time.sleep(2.2)
res=rpc(dict(schemaVersion=1,action='inspect',operationId=op))
assert res['state']=='uncertain',res
print('Synthetic supervisor SIGKILL: cancellation not confirmed; inspection remains uncertain after child exit.')
