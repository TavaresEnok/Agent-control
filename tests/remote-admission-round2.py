"""Journal admission fails closed on terminal records without receipts."""
import json, pathlib, subprocess, sys, tempfile, time, uuid
worker=pathlib.Path(__file__).resolve().parents[1]/'services/remote-worker/worker.py'
with tempfile.TemporaryDirectory(prefix='ac-admission-') as temp:
    root=pathlib.Path(temp); project=root/'project'; project.mkdir(); journal=root/'journal';journal.mkdir(mode=0o700)
    project_id=str(uuid.uuid4()); old=str(uuid.uuid4()); operation=str(uuid.uuid4()); config=root/'config.json'
    config.write_text(json.dumps({'stateDirectory':str(journal),'projects':{project_id:str(project)},'tasks':{'task':['/bin/true']},'maxConcurrent':1}))
    record=journal/(old+'.json');record.write_text(json.dumps({'operationId':old,'state':'completed'}))
    request={'schemaVersion':1,'action':'start','operationId':operation,'projectId':project_id,'taskId':'task','root':str(project),'epoch':1}
    def invoke():
        return subprocess.run([sys.executable,str(worker),'--config',str(config)],input=json.dumps(request),text=True,capture_output=True)
    assert invoke().returncode != 0
    record.write_text(json.dumps({'operationId':old,'state':'completed','exitCode':0,'logSha256':'0'*64}))
    assert invoke().returncode == 0
    for _ in range(100):
        item=json.loads((journal/(operation+'.json')).read_text())
        if item['state']=='completed':break
        time.sleep(.02)
    assert item['state']=='completed',item
print('Incomplete terminal receipt keeps capacity; complete terminal receipt releases it.')
