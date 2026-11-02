from pathlib import Path
import subprocess,json,hashlib,os,sys
root=Path(__file__).resolve().parent.parent
base=Path(sys.argv[1] if len(sys.argv)>1 else '/home/app/projects/agent-control-evaluation-v3/candidates')
result={}
for name in ['cezar','happier']:
 result[name]=[]
 tree=subprocess.check_output(['git','-C',str(base/name),'ls-tree','-rz','HEAD'])
 for item in tree.split(b'\0'):
  if not item:continue
  meta,raw=item.split(b'\t',1);mode,kind,old=meta.decode().split();rel=raw.decode();p=root/'upstream'/name/rel
  if not p.exists() and not p.is_symlink():
   result[name].append({'path':rel,'change':'missing','upstream_blob':old});continue
  value=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
  blob=hashlib.sha1(b'blob '+str(len(value)).encode()+b'\0'+value).hexdigest()
  if blob!=old:result[name].append({'path':rel,'upstream_blob':old,'current_blob':blob,'sha256':hashlib.sha256(value).hexdigest()})
for rel in ['packages/web/src/components/composer/canonical-chat.test.tsx','packages/cezar/src/git-worktree-identity.test.ts','packages/web/src/routes/settings/agent-control-section.tsx','packages/web/src/routes/settings/agent-control-operator.ts']:
 p=root/'upstream/cezar'/rel
 result['cezar'].append({'path':rel,'change':'added','sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(root/'upstream/CHANGES.json').write_text(json.dumps(result,indent=2)+'\n')
print({k:len(v) for k,v in result.items()})
