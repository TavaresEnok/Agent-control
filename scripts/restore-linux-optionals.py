# Install only exact-version Linux x64 optional binaries already fetched by Yarn's pinned lockfile.
from pathlib import Path
import json,shutil,os
root=Path(__file__).resolve().parent.parent; repo=root/'upstream/happier';catalog={}
for d in (root/'.state/yarn-cache/v6').iterdir():
 for p in list((d/'node_modules').glob('*/package.json'))+list((d/'node_modules').glob('@*/*/package.json')):
  q=json.loads(p.read_text());catalog[(q.get('name'),q.get('version'))]=p.parent
changes=[]
for directory,dirs,files in os.walk(repo):
 if 'package.json' not in files:continue
 p=Path(directory)/'package.json'
 try:q=json.loads(p.read_text())
 except (ValueError,OSError):continue
 for name,version in q.get('optionalDependencies',{}).items():
  src=catalog.get((name,version))
  if not src:continue
  meta=json.loads((src/'package.json').read_text())
  if 'linux' not in meta.get('os',[]) or 'x64' not in meta.get('cpu',['x64']):continue
  if name.endswith('-gnu') or '-gnu-' in name:continue
  dest=p.parent/'node_modules'/name
  if dest.exists():continue
  dest.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(src,dest)
  changes.append({'requester':q.get('name'),'name':name,'version':version})
(root/'docs/validation/evidence/linux-optionals.json').write_text(json.dumps(changes,indent=2));print('RESTORED_EXACT_LINUX_OPTIONALS',len(changes))
