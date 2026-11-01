#!/usr/bin/python3
import sys,subprocess,json,os,time
prompt=sys.argv[-1]
if '--probe-failure' in sys.argv:sys.exit(17)
if '--probe-cancel' in sys.argv:time.sleep(120);sys.exit(0)
if 'Contrato: ' in prompt:
 contract=json.JSONDecoder().raw_decode(prompt.split('Contrato: ',1)[1])[0]
 try:
  open('/work/forbidden-write','w').write('bad')
 except OSError:pass
 else:raise RuntimeError('review worktree writable')
 contract['verdict']='approved';contract['findings']=[]
 open('/evidence/review.json','w').write(json.dumps(contract));sys.exit(0)
open('/work/value.txt','a').write('worker-change\n')
for argv in [['git','-c','safe.directory=/work','add','value.txt'],['git','-c','safe.directory=/work','-c','user.name=Probe','-c','user.email=probe@example.invalid','commit','-m','Probe artifact']]:
 subprocess.run(argv,check=True)
assert not os.path.exists('/var/run/docker.sock')
assert not os.environ.get('DB_PASSWORD')
assert not os.environ.get('OPENAI_API_KEY')
