"""Exercise the journal in a disconnected disposable container, without real SSH."""
import json, os, pathlib, subprocess, tempfile, time, unittest, uuid

WORKER = pathlib.Path('/workspace/services/remote-worker/worker.py')

class RemoteJournal(unittest.TestCase):
 def test_duplicate_and_lost_ack(self):
  with tempfile.TemporaryDirectory(prefix='ac-remote-') as temp:
   base=pathlib.Path(temp); project=base/'project'; project.mkdir()
   project_id=str(uuid.uuid4()); operation_id=str(uuid.uuid4()); config=base/'config.json'
   config.write_text(json.dumps({'stateDirectory':str(base/'journal'),'projects':{project_id:str(project)},
      'tasks':{'fixture':['/usr/local/bin/python3','-c',"import pathlib,time;p=pathlib.Path('launches');p.open('a').write('x');time.sleep(.25)"]},'maxSeconds':5,'maxLogBytes':4096}))
   def rpc(request):
    return subprocess.run(['/usr/local/bin/python3',str(WORKER),'--config',str(config)],input=json.dumps(request),
     capture_output=True,text=True,timeout=5)
   start={'schemaVersion':1,'action':'start','operationId':operation_id,'projectId':project_id,
          'taskId':'fixture','root':str(project),'epoch':1}
   first=rpc(start);self.assertEqual(first.returncode,0);self.assertEqual(json.loads(first.stdout)['state'],'uncertain')
   self.assertEqual(rpc(start).returncode,0) # acknowledgement is discarded; no duplicate process
   for _ in range(100):
    response=rpc({'schemaVersion':1,'action':'inspect','operationId':operation_id});self.assertEqual(response.returncode,0)
    result=json.loads(response.stdout)
    if result['state'] in ('completed','failed'):break
    time.sleep(.05)
   self.assertEqual(result['state'],'completed');self.assertEqual(result['exitCode'],0);self.assertEqual(len(result['logSha256']),64)
   self.assertEqual((project/'launches').read_text(),'x')
   self.assertEqual(json.loads(rpc(start).stdout)['state'],'completed')
   self.assertNotEqual(rpc({**start,'epoch':2}).returncode,0)
   self.assertNotEqual(rpc({**start,'operationId':str(uuid.uuid4()),'taskId':'forbidden'}).returncode,0)
   (base/'journal').chmod(0o755)
   self.assertNotEqual(rpc({'schemaVersion':1,'action':'inspect','operationId':operation_id}).returncode,0)

 def test_cancel_is_requested_before_parent_confirms_physical_exit(self):
  with tempfile.TemporaryDirectory(prefix='ac-remote-cancel-') as temp:
   base=pathlib.Path(temp);project=base/'project';project.mkdir();project_id=str(uuid.uuid4());operation_id=str(uuid.uuid4());config=base/'config.json'
   config.write_text(json.dumps({'stateDirectory':str(base/'journal'),'projects':{project_id:str(project)},
    'tasks':{'slow':['/usr/local/bin/python3','-c',"import pathlib,time;pathlib.Path('started').write_text('yes');time.sleep(10);pathlib.Path('must-not-exist').write_text('late')"]},'maxSeconds':15,'maxLogBytes':4096}))
   def rpc(request):
    return subprocess.run(['/usr/local/bin/python3',str(WORKER),'--config',str(config)],input=json.dumps(request),capture_output=True,text=True,timeout=5)
   start={'schemaVersion':1,'action':'start','operationId':operation_id,'projectId':project_id,'taskId':'slow','root':str(project),'epoch':3}
   self.assertEqual(rpc(start).returncode,0)
   for _ in range(100):
    if (project/'started').exists():break
    time.sleep(.02)
   self.assertTrue((project/'started').exists())
   cancel={k:v for k,v in start.items() if k!='root'};cancel['action']='cancel'
   self.assertNotEqual(rpc({**cancel,'epoch':4}).returncode,0)
   result=rpc(cancel);self.assertEqual(result.returncode,0)
   requested=json.loads(result.stdout)
   self.assertIn(requested['state'],('running','canceled_confirmed'))
   if requested['state']=='running':self.assertTrue(requested['cancellationRequested'])
   for _ in range(100):
    result=json.loads(rpc({'schemaVersion':1,'action':'inspect','operationId':operation_id}).stdout)
    if result['state']=='canceled_confirmed':break
    time.sleep(.02)
   self.assertEqual(result['state'],'canceled_confirmed');self.assertLess(result['exitCode'],0);self.assertEqual(len(result['logSha256']),64)
   self.assertFalse((project/'must-not-exist').exists());self.assertEqual(json.loads(rpc(cancel).stdout),result)

if __name__=='__main__':unittest.main(verbosity=2)
