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
# Capture the selected Git delivery (including staged new files), rather than
# unrelated interpreter caches or untracked files produced while proving it.
selected=subprocess.check_output(['git','ls-files','-z'],cwd=root).split(b'\0')
for raw in sorted(filter(None,selected)):
 name=raw.decode();parts=Path(name).parts
 if parts[0] not in ['src','adapters','db','tests','scripts','services']:continue
 if any(part in ['.state','node_modules','__pycache__','dist'] for part in parts):continue
 p=root/name
 if p.is_file() and not p.is_symlink():result['new_sources'][name]=hashlib.sha256(p.read_bytes()).hexdigest()
result['criteria_sha256']=hashlib.sha256((root/'docs/validation/ACCEPTANCE-I0-I2.md').read_bytes()).hexdigest()
(root/'docs/validation/evidence/IMPLEMENTATION_PROVENANCE.json').write_text(json.dumps(result,indent=2)+'\n')
