#!/usr/bin/env python3
"""Deterministic source snapshot from one Git commit; never package live files."""
import argparse,gzip,hashlib,io,json,os,posixpath,re,subprocess,tarfile,tempfile
from contextlib import contextmanager
from pathlib import Path,PurePosixPath

class PackageError(Exception):pass

def git(root,*args):
 return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL)

def is_environment(name):
 path=PurePosixPath(name)
 return path.name=='.env' or path.name.startswith('.env.') and not path.name.endswith('.example')

def omitted_upstream_environment(name):
 return name.startswith(('upstream/cezar/','upstream/happier/')) and is_environment(name)

def environment_exclusions(root,commit):
 excluded=[]
 for entry in git(root,'ls-tree','-rz',commit).split(b'\0'):
  if not entry:continue
  meta,raw=entry.split(b'\t',1);mode,kind,oid=meta.decode().split();name=raw.decode('utf8')
  if omitted_upstream_environment(name):excluded.append({'path':name,'gitBlob':oid,'reason':'upstream_environment_configuration_not_distributed'})
 return sorted(excluded,key=lambda value:value['path'])

def entries(root,commit):
 result={}
 for entry in git(root,'ls-tree','-rz',commit).split(b'\0'):
  if not entry:continue
  meta,raw=entry.split(b'\t',1);mode,kind,oid=meta.decode().split();name=raw.decode('utf8')
  path=PurePosixPath(name)
  if name in ('SOURCE-MANIFEST.json','SOURCE-REVISION.txt'):raise PackageError('RESERVED_PACKAGE_PATH')
  if path.is_absolute() or '..' in path.parts or '\\' in name or any(ord(c)<32 for c in name):raise PackageError('UNSAFE_SOURCE_PATH')
  if kind!='blob' or mode not in ('100644','100755','120000'):raise PackageError('UNSUPPORTED_GIT_ENTRY: '+name)
  if any(part in ('.git','.state','node_modules','__pycache__') for part in path.parts):raise PackageError('PRIVATE_OR_DEPENDENCY_PATH: '+name)
  if omitted_upstream_environment(name):continue
  if is_environment(name):raise PackageError('PRIVATE_ENVIRONMENT_PATH: '+name)
  if 'dist' in path.parts or path.suffix in ('.tsbuildinfo','.pyc'):continue
  result[name]=(mode,oid)
 return result

def blob(root,oid):return git(root,'cat-file','blob',oid)
@contextmanager
def batch_reader(root):
 process=subprocess.Popen(['git','-C',str(root),'cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 def read(oid):
  process.stdin.write((oid+'\n').encode());process.stdin.flush()
  header=process.stdout.readline().decode().strip().split()
  if len(header)!=3 or header[1]!='blob':raise PackageError('GIT_BLOB_UNAVAILABLE')
  data=process.stdout.read(int(header[2]));terminator=process.stdout.read(1)
  if len(data)!=int(header[2]) or terminator!=b'\n':raise PackageError('GIT_BLOB_TRUNCATED')
  return data
 try:yield read
 finally:
  process.stdin.close();process.stdout.close();process.wait(timeout=5)

def sha(data):return hashlib.sha256(data).hexdigest()
def js(data):return (json.dumps(data,sort_keys=True,indent=2,ensure_ascii=False)+'\n').encode()

def validate(root,commit):
 selected=entries(root,commit)
 required=['package.json','package-lock.json','upstream/cezar/package-lock.json','upstream/happier/yarn.lock',
  'upstream/PROVENANCE.json','upstream/CHANGES.json','docs/validation/evidence/IMPLEMENTATION_PROVENANCE.json',
  'docs/validation/ACCEPTANCE-I0-I2.md','docs/operations/DISTRIBUTION.md']
 for name in required:
  if name not in selected:raise PackageError('REQUIRED_SOURCE_MISSING: '+name)
 def read(name):return blob(root,selected[name][1])
 package=json.loads(read('package.json'));lock=json.loads(read('package-lock.json'))
 if lock.get('name')!=package.get('name') or lock.get('version')!=package.get('version') or lock.get('lockfileVersion')!=3:raise PackageError('ROOT_LOCK_MISMATCH')
 provenance=json.loads(read('upstream/PROVENANCE.json'))
 for upstream in ('cezar','happier'):
  if not re.fullmatch('[a-f0-9]{40}',provenance.get(upstream,{}).get('commit','')):raise PackageError('UPSTREAM_COMMIT_REQUIRED')
  patch='upstream/patches/'+upstream+'-complete.patch'
  if patch not in selected or sha(read(patch))!=provenance[upstream].get('patch_sha256'):raise PackageError('UPSTREAM_PATCH_PROVENANCE_STALE')
 implementation=json.loads(read('docs/validation/evidence/IMPLEMENTATION_PROVENANCE.json'))
 recorded=implementation.get('new_sources',{})
 actual={name for name in selected if name.split('/')[0] in ('src','adapters','db','tests','scripts','services')}
 if set(recorded)!=actual:raise PackageError('SOURCE_PROVENANCE_COVERAGE_MISMATCH')
 for name,expected in recorded.items():
  if sha(read(name))!=expected:raise PackageError('SOURCE_PROVENANCE_STALE: '+name)
 if sha(read('docs/validation/ACCEPTANCE-I0-I2.md'))!=implementation.get('criteria_sha256'):raise PackageError('CRITERIA_PROVENANCE_STALE')
 changes=json.loads(read('upstream/CHANGES.json'));modified=set()
 for upstream in ('cezar','happier'):
  if not isinstance(changes.get(upstream),list):raise PackageError('UPSTREAM_CHANGES_REQUIRED')
  for change in changes[upstream]:
   name='upstream/'+upstream+'/'+change['path'];modified.add(name)
   if change.get('change')=='missing':
    if name in selected:raise PackageError('UPSTREAM_DELETION_STALE: '+name)
   elif name not in selected or sha(read(name))!=change.get('sha256'):raise PackageError('UPSTREAM_CHANGE_STALE: '+name)
 # High-confidence private-key/token patterns in our additions and modified
 # upstream files. Public unchanged upstream fixtures are not relabeled secrets.
 suspect=re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}')
 for name in sorted(actual|modified):
  if name not in selected:continue
  if suspect.search(read(name)):raise PackageError('POSSIBLE_CREDENTIAL_IN_SOURCE: '+name)
 return selected,provenance

def write_package(root,commit,output):
 selected,provenance=validate(root,commit)
 timestamp=int(git(root,'show','-s','--format=%ct',commit).strip())
 output=output.resolve();root=root.resolve()
 if output==root or root in output.parents:raise PackageError('OUTPUT_MUST_BE_OUTSIDE_REPOSITORY')
 if output.exists():raise PackageError('OUTPUT_ALREADY_EXISTS')
 manifest={'schemaVersion':1,'kind':'source-only','commit':commit,'sourceDateEpoch':timestamp,
  'upstreams':{key:value['commit'] for key,value in provenance.items() if key in ('cezar','happier')},'files':[],'excluded':environment_exclusions(root,commit)}
 descriptor,temp=tempfile.mkstemp(prefix='.agent-control-package-',dir=output.parent)
 try:
  with os.fdopen(descriptor,'wb') as raw,gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=0) as compressed,tarfile.open(fileobj=compressed,mode='w',format=tarfile.PAX_FORMAT) as archive,batch_reader(root) as read:
   def add(name,data,mode=0o644):
    info=tarfile.TarInfo('agent-control/'+name);info.size=len(data);info.mode=mode;info.mtime=timestamp;archive.addfile(info,io.BytesIO(data))
   for name,(mode,oid) in sorted(selected.items()):
    data=read(oid)
    if mode=='120000':
     target=data.decode('utf8');resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target))
     if target.startswith('/') or resolved=='..' or resolved.startswith('../'):raise PackageError('UNSAFE_SOURCE_SYMLINK: '+name)
     info=tarfile.TarInfo('agent-control/'+name);info.type=tarfile.SYMTYPE;info.linkname=target;info.mode=0o777;info.mtime=timestamp;archive.addfile(info)
    else:add(name,data,0o755 if mode=='100755' else 0o644)
    manifest['files'].append({'path':name,'mode':mode,'bytes':len(data),'sha256':sha(data)})
   add('SOURCE-MANIFEST.json',js(manifest))
   add('SOURCE-REVISION.txt',(commit+'\n').encode())
  os.link(temp,output);os.unlink(temp)
 except BaseException:
  if os.path.exists(temp):os.unlink(temp)
  raise
 hasher=hashlib.sha256()
 with output.open('rb') as packaged:
  for chunk in iter(lambda:packaged.read(1048576),b''):hasher.update(chunk)
 checksum=hasher.hexdigest()
 return {'commit':commit,'files':len(selected),'archive':str(output),'sha256':checksum,'kind':'source-only'}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parent.parent)
 parser.add_argument('--commit',required=True);parser.add_argument('--output',type=Path);parser.add_argument('--check',action='store_true')
 args=parser.parse_args();root=args.repo.resolve()
 if args.check and args.output or not args.check and not args.output:raise PackageError('CHOOSE_CHECK_OR_OUTPUT')
 commit=git(root,'rev-parse','--verify',args.commit+'^{commit}').decode().strip()
 if args.check:
  selected,_=validate(root,commit);print(json.dumps({'commit':commit,'files':len(selected),'state':'source_selection_validated','kind':'source-only','omittedUpstreamEnvironmentFiles':len(environment_exclusions(root,commit))}))
 else:print(json.dumps(write_package(root,commit,args.output)))
if __name__=='__main__':
 try:main()
 except (PackageError,subprocess.CalledProcessError,ValueError,KeyError) as error:
  raise SystemExit('SOURCE_PACKAGE_REFUSED: '+(str(error) if isinstance(error,PackageError) else type(error).__name__))
