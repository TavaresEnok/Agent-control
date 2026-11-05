#!/usr/bin/env python3
"""Finite real-Docker same-installation race/orphan proof, no skips."""
import concurrent.futures
import copy
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'services/remote-worker'))
from resource_authority import docker,verify,reservation,installation_directory,installation_lock,ledger_path,_reservation_paths
image=os.environ.get('R3_RESOURCE_IMAGE','agent-control-ssh-lab:0.1.0')
installation='ac-r3-resources-installation-'+uuid.uuid4().hex
owned=[]
config=None
results={}

def rejected(action,code):
 try: action()
 except ValueError as error: assert code in str(error),str(error)
 else: raise AssertionError('Expected '+code)

try:
 with tempfile.TemporaryDirectory(prefix='ac-r3-installation-') as temporary:
  area=pathlib.Path(temporary)
  def provision(index):
   authority='ac-r3-resources-'+uuid.uuid4().hex
   output=area/(str(index)+'.json')
   result=subprocess.run([sys.executable,str(ROOT/'scripts/r3-provision-resource-authority.py'),'--lab-provision',
    '--authority',authority,'--installation',installation,'--image',image,'--output',str(output),'--jobs','2'],capture_output=True,text=True,timeout=30)
   return result,output
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: attempts=list(pool.map(provision,[1,2]))
  winners=[output for result,output in attempts if result.returncode==0]
  assert len(winners)==1,[(r.returncode,r.stderr[-300:]) for r,_ in attempts]
  for result,_ in attempts:
   if result.returncode: assert 'RESOURCE_AUTHORITY_BUSY' in result.stderr or 'RESOURCE_INSTALLATION_ALREADY_BOUND' in result.stderr,result.stderr
  config=json.loads(winners[0].read_text());anchor=config['resourceAuthority']['anchorId'];owned.append(anchor)
  _,parent=verify(config)
  assert docker('ps','-aq','--no-trunc','--filter','label=ac.resources.installation='+installation).splitlines()==[anchor]
  with installation_lock(config):
   busy=subprocess.run([sys.executable,'-c',"import json,sys;sys.path.insert(0,sys.argv[1]);from resource_authority import verify;verify(json.loads(sys.argv[2]))",str(ROOT/'services/remote-worker'),json.dumps(config)],capture_output=True,text=True,timeout=10)
   assert busy.returncode and 'RESOURCE_AUTHORITY_BUSY' in busy.stderr,busy.stderr
  results['concurrentProvisioning']={'controllers':2,'differentAuthorities':True,'createdBudgets':1}
  loser,_=provision(3);assert loser.returncode and 'RESOURCE_INSTALLATION_ALREADY_BOUND' in loser.stderr
  bad=copy.deepcopy(config);bad['resourceAuthority']['authorityId']='ac-r3-resources-'+uuid.uuid4().hex
  rejected(lambda:verify(bad),'RESOURCE_INSTALLATION_AUTHORITY_CONFLICT')
  # A foreign budget carrying this installation identity must also fence runtime.
  rogueAuthority='ac-r3-resources-'+uuid.uuid4().hex
  rogueParent='acr'+hashlib.sha256(rogueAuthority.encode()).hexdigest()[:24]+'.slice'
  rogue=docker('create','--label','ac.r3.disposable=true','--label','ac.resources.installation='+installation,
   '--label','ac.resources.authority='+rogueAuthority,'--cgroup-parent',rogueParent,'--entrypoint','sleep',image,'60');owned.append(rogue)
  rejected(lambda:verify(config),'RESOURCE_INSTALLATION_AUTHORITY_CONFLICT')
  docker('rm','-f',rogue);owned.remove(rogue);verify(config)
  operation=str(uuid.uuid4())
  with reservation(config,operation,1) as options:
   orphan=docker('create',*options,'--label','ac.r3.disposable=true','--entrypoint','sleep',image,'60');owned.append(orphan)
  docker('start',orphan)
  assert json.loads(docker('inspect',orphan))[0]['State']['Running']
  # Anchor removal is not resource retirement: the child remains physically capped.
  docker('rm','-f',anchor);owned.remove(anchor)
  assert json.loads(docker('inspect',orphan))[0]['State']['Running']
  assert (pathlib.Path('/sys/fs/cgroup')/parent/'cpu.max').read_text().strip()=='50000 100000'
  install=installation_directory(config);binding=(install/'binding.json').read_bytes();(install/'binding.json').unlink()
  rejected(lambda:verify(config),'RESOURCE_INSTALLATION_BINDING_MISSING')
  # Even with the ledger lost, orphan labels prevent a new independent envelope.
  loser,_=provision(4);assert loser.returncode and 'RESOURCE_INSTALLATION_GROUPS_EXIST' in loser.stderr,loser.stderr
  (install/'binding.json').write_bytes(binding);(install/'binding.json').chmod(0o600)
  results['orphanBudget']={'childRunningAfterAnchorLoss':True,'physicalParentStillCapped':True,
   'lostBindingBlocksRuntime':True,'orphanLabelsBlockReprovision':True}
  docker('rm','-f',orphan);owned.remove(orphan)
  pending=json.loads(binding);pending['anchorId']=None;(install/'binding.json').write_text(json.dumps(pending))
  loser,_=provision(5);assert loser.returncode and 'RESOURCE_INSTALLATION_ALREADY_BOUND' in loser.stderr,loser.stderr
  results['pendingProvisioningRetainedWithoutGroups']=True
  results['negativeCases']=['second authority same installation','changed authority configuration','foreign installation-labeled group','binding missing with live orphan','normalized contention error','pending binding with no groups']
  print(json.dumps({'passed':True,'results':results},indent=2))
finally:
 for identifier in owned:
  inspected=json.loads(docker('inspect',identifier))[0]
  assert inspected['Config']['Labels'].get('ac.resources.installation')==installation
  docker('rm','-f',identifier)
 assert not docker('ps','-aq','--filter','label=ac.resources.installation='+installation)
 if config:
  for path in list(_reservation_paths(config)):path.unlink()
  ledger_path(config).unlink(missing_ok=True)
  directory=installation_directory(config)
  (directory/'binding.json').unlink(missing_ok=True)
  (directory/'authority.lock').unlink()
  directory.rmdir()
