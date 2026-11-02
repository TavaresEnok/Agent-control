from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).resolve().parent.parent
result={}
for label,args in [('toolchain',['docker','image','inspect','agent-control-lab:0.1.0']),('postgres',['docker','image','inspect','postgres@sha256:4327b9fd295502f326f44153a1045a7170ddbfffed1c3829798328556cfd09e2'])]:
 d=json.loads(subprocess.check_output(args))[0]
 result[label]={'id':d['Id'],'repo_digests':d['RepoDigests']}
result['git_head_before_delivery']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
result['worktree_changes_present']=bool(subprocess.check_output(['git','status','--porcelain'],cwd=root))
result['new_sources']={}
for folder in ['src','adapters','db','tests','scripts','services']:
 for p in sorted((root/folder).rglob('*')):
  if p.is_file():result['new_sources'][p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
result['criteria_sha256']=hashlib.sha256((root/'docs/validation/ACCEPTANCE-I0-I2.md').read_bytes()).hexdigest()
(root/'docs/validation/evidence/IMPLEMENTATION_PROVENANCE.json').write_text(json.dumps(result,indent=2)+'\n')
