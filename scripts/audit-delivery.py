from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).resolve().parent.parent
fixture=json.loads((root/'.state/browser-fixture.json').read_text())
secrets=[fixture[k] for k in ['token','secret'] if isinstance(fixture.get(k),str) and len(fixture[k])>20]
files=[p.decode() for p in subprocess.check_output(['git','ls-files','-z'],cwd=root).split(b'\0') if p]
hits=[];bad=[]
for name in files:
 if name.startswith(('.state/','node_modules/','dist/','upstream/cezar/node_modules/','upstream/happier/node_modules/')):bad.append(name)
 p=root/name
 if p.is_symlink() or not p.is_file():continue
 data=p.read_bytes()
 if any(secret.encode() in data for secret in secrets):hits.append(name)
result={'result':'passed' if not hits and not bad else 'failed','tracked_files_scanned':len(files),'latest_synthetic_secret_values_checked':len(secrets),'secret_hits':hits,'forbidden_paths':bad,'scope':'Exact current synthetic token/key and private/build root paths. Original public upstream test fixtures retained. This is not a full secret scanner or security certification.'}
(root/'docs/validation/evidence/DELIVERY_AUDIT.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result));assert not hits and not bad
