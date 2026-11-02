from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).resolve().parent.parent
result={}
for label,args in [('toolchain',['docker','image','inspect','ac-proof-v3-complete:20261101']),('postgres',['docker','image','inspect','postgres:16-alpine'])]:
 d=json.loads(subprocess.check_output(args))[0]
 result[label]={'id':d['Id'],'repo_digests':d['RepoDigests'],'env':d['Config']['Env']}
result['new_sources']={}
for folder in ['src','adapters','db','tests','scripts']:
 for p in sorted((root/folder).rglob('*')):
  if p.is_file():result['new_sources'][p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
result['criteria_sha256']=hashlib.sha256((root/'docs/validation/ACCEPTANCE-I0-I2.md').read_bytes()).hexdigest()
(root/'docs/validation/evidence/IMPLEMENTATION_PROVENANCE.json').write_text(json.dumps(result,indent=2)+'\n')
