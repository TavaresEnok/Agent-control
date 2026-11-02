"""Small source-package acceptance; no dependencies, Docker, accounts or builds."""
import importlib.util,json,subprocess,tempfile,tarfile,sys
sys.dont_write_bytecode=True
from pathlib import Path
from unittest import TestCase,main
spec=importlib.util.spec_from_file_location('package_source',Path(__file__).resolve().parents[1]/'scripts/package-source.py')
package=importlib.util.module_from_spec(spec);spec.loader.exec_module(package)
class Packaging(TestCase):
 def test_reproducible_committed_snapshot_and_private_refusal(self):
  with tempfile.TemporaryDirectory(prefix='ac-package-') as folder:
   root=Path(folder)/'repo';root.mkdir();subprocess.run(['git','init','-q',str(root)],check=True)
   def put(name,value):
    path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(value.encode() if isinstance(value,str) else value)
   def commit():
    subprocess.run(['git','-C',str(root),'add','.'],check=True)
    subprocess.run(['git','-C',str(root),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic package'],check=True)
    return package.git(root,'rev-parse','HEAD').decode().strip()
   for name,value in {'package.json':json.dumps({'name':'fixture','version':'1'}),
    'package-lock.json':json.dumps({'name':'fixture','version':'1','lockfileVersion':3}),
    'upstream/cezar/package-lock.json':'{}','upstream/happier/yarn.lock':'# synthetic',
    'upstream/PROVENANCE.json':json.dumps({name:{'commit':'a'*40,'patch_sha256':package.sha(('synthetic '+name).encode())} for name in ['cezar','happier']}),
    'upstream/CHANGES.json':json.dumps({'cezar':[],'happier':[]}),
    'upstream/happier/apps/cli/.env.dev':'PUBLIC_FIXTURE_SECRET=not-distributed',
    'upstream/patches/cezar-complete.patch':'synthetic cezar','upstream/patches/happier-complete.patch':'synthetic happier',
    'docs/validation/ACCEPTANCE-I0-I2.md':'synthetic criteria','docs/operations/DISTRIBUTION.md':'synthetic instructions',
    'src/fixture.ts':'export const synthetic=true;\n'}.items():put(name,value)
   def provenance():
    put('docs/validation/evidence/IMPLEMENTATION_PROVENANCE.json',json.dumps({'new_sources':{'src/fixture.ts':package.sha((root/'src/fixture.ts').read_bytes())},
     'criteria_sha256':package.sha((root/'docs/validation/ACCEPTANCE-I0-I2.md').read_bytes())}))
   provenance();revision=commit()
   # Live files (including secrets) do not affect an immutable committed package.
   put('src/fixture.ts','uncommitted sensitive difference');put('.state/private-token','synthetic-private-value')
   outputs=[Path(folder)/(name+'.tar.gz') for name in ['one','two']]
   for output in outputs:package.write_package(root,revision,output)
   self.assertEqual(outputs[0].read_bytes(),outputs[1].read_bytes())
   with tarfile.open(outputs[0]) as archive:
    names=archive.getnames();self.assertFalse(any('.state' in name for name in names));self.assertFalse(any(name.endswith('/.env.dev') for name in names))
    manifest=json.load(archive.extractfile('agent-control/SOURCE-MANIFEST.json'))
    self.assertEqual(manifest['excluded'][0]['path'],'upstream/happier/apps/cli/.env.dev')
    self.assertEqual(manifest['excluded'][0]['reason'],'upstream_environment_configuration_not_distributed')
    for record in manifest['files']:
     self.assertEqual(package.sha(archive.extractfile('agent-control/'+record['path']).read()),record['sha256'])
   with self.assertRaisesRegex(package.PackageError,'OUTPUT_ALREADY_EXISTS'):package.write_package(root,revision,outputs[0])
   # Tracked sensitive material is rejected even if a user bypassed gitignore.
   private=commit()
   with self.assertRaisesRegex(package.PackageError,'PRIVATE_OR_DEPENDENCY_PATH'):package.validate(root,private)
   subprocess.run(['git','-C',str(root),'rm','-q','.state/private-token'],check=True)
   put('.env','SECRET=synthetic-must-be-refused');put('src/fixture.ts','export const synthetic=true;\n');provenance();environment=commit()
   with self.assertRaisesRegex(package.PackageError,'PRIVATE_ENVIRONMENT_PATH'):package.validate(root,environment)
   subprocess.run(['git','-C',str(root),'rm','-q','.env'],check=True)
   put('src/fixture.ts','const privateKey="-----BEGIN '+'PRIVATE KEY-----";');provenance();secret=commit()
   with self.assertRaisesRegex(package.PackageError,'POSSIBLE_CREDENTIAL_IN_SOURCE'):package.validate(root,secret)
if __name__=='__main__':main()
