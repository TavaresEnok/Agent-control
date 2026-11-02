from pathlib import Path
import subprocess,json,hashlib,base64
root=Path(__file__).resolve().parent.parent
fixture=json.loads((root/'.state/browser-fixture.json').read_text())
secrets=[fixture[k].encode() for k in ['token','secret'] if isinstance(fixture.get(k),str) and len(fixture[k])>20]
for keyfile in (root/'.state/keys').glob('*'):
 if not keyfile.is_file() or keyfile.is_symlink():continue
 value=keyfile.read_bytes().strip()
 if len(value)>=24:secrets.extend([value,base64.b64encode(value),value.hex().encode()])
files=[p.decode() for p in subprocess.check_output(['git','ls-files','-z'],cwd=root).split(b'\0') if p]
hits=[];bad=[]
for name in files:
 if name.startswith(('.state/','node_modules/','dist/','upstream/cezar/node_modules/','upstream/happier/node_modules/')):bad.append(name)
 p=root/name
 if p.is_symlink() or not p.is_file():continue
 data=p.read_bytes()
 if any(secret in data for secret in secrets):hits.append(name)
result={'result':'passed' if not hits and not bad else 'failed','tracked_files_scanned':len(files),'synthetic_secret_encodings_checked':len(secrets),'secret_hits':hits,'forbidden_paths':bad,'scope':'Current synthetic token and local keys in selected encodings, plus private/build root paths. Original public upstream fixtures retained. Not a full secret scanner or security certification.'}
(root/'docs/validation/evidence/DELIVERY_AUDIT.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result));assert not hits and not bad
