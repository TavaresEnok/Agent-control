import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {backupManifestDigest,verifyRestore} from '../src/restore-verifier.ts';
import {RESTORE_VERIFY_EXIT_APTO,RESTORE_VERIFY_EXIT_INAPTO,RESTORE_VERIFY_EXIT_PARCIAL,RESTORE_VERIFY_EXIT_USAGE} from '../src/restore-verify-cli.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
const cli=fileURLToPath(new URL('../src/restore-verify-cli.ts',import.meta.url));
const CREATED='2026-11-03T12:00:00.000Z';
const AFTER='2026-11-03T12:00:00.001Z';
const DATABASE='c'.repeat(64);
const SECRET='SECRET_PATH_/etc/passwd token=do-not-leak';
const FILES=[
 {path:'.state/keys/lab-key',size:4,sha256:'11'.repeat(32)},
 {path:'.state/happier/server.sqlite',size:8,sha256:'22'.repeat(32)},
 {path:'.state/browser-fixture.json',size:12,sha256:'33'.repeat(32)},
 {path:'.state/projects/plan.json',size:16,sha256:'44'.repeat(32)},
];

function manifest(){
 return {schemaVersion:1,scope:'isolated-synthetic-lab',backupId:'2026-11-03T12-00-00-000Z-ab12cd34',root:SECRET,createdAt:CREATED,
  commit:'a'.repeat(40),sources:['.state/happier','.state/projects','.state/browser-fixture.json','.state/keys'],missingOptional:[],
  files:FILES.map(file=>({...file})),databaseSha256:DATABASE,
  limitation:'Requires the same isolated root for absolute Git worktree links. No production restore/admission is authorized.'};
}
function observed(){
 return {schemaVersion:1,database:{version:1,digest:DATABASE},versions:{vault:1,context:1,ui_state:1,plan_receipts:1},files:FILES.map(file=>({...file}))};
}
function run(args:string[]){
 return spawnSync(process.execPath,['--import','tsx',cli,...args],{encoding:'utf8',cwd:root});
}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'restore-verify-cli-'));
 const manifestPath=join(dir,'MANIFEST.json');
 const observationPath=join(dir,'observation.json');
 const effectsPath=join(dir,'effects.json');
 const sidecarPath=join(dir,'archive.json');
 const archivePath=join(dir,'archive.acbackup');
 await writeFile(manifestPath,JSON.stringify(manifest(),null,2));
 await writeFile(observationPath,JSON.stringify(observed()));
 await writeFile(effectsPath,'[]');
 await writeFile(archivePath,Buffer.from('encrypted-bytes-unchanged'));
 return {dir,manifestPath,observationPath,effectsPath,sidecarPath,archivePath,async cleanup(){await rm(dir,{recursive:true,force:true});}};
}

test('apto, parcial, digest ausente ou divergente, manifesto truncado e efeito posterior saem com o código do veredito',async()=>{
 const files=await fixture();
 try{
  const body=manifest();
  const producer=await import(new URL('../scripts/backup-lab.mjs',import.meta.url).href) as {
   backupArchiveSidecarFromProducer:(manifest:Record<string,unknown>,fields:Record<string,unknown>)=>Promise<Record<string,string|number>>;
   encryptedBackupHeader:(backupId:string,ivBase64:string)=>string;
  };
  const before=await readFile(files.archivePath);
  const sidecar=await producer.backupArchiveSidecarFromProducer(body,{scope:body.scope,archive:files.archivePath,tagFile:files.archivePath+'.tag',keyFile:files.archivePath+'.key',sha256:'ab'.repeat(32),sourceFiles:FILES.length,size:before.byteLength,warning:'Key material is local and separate from the archive. Off-host custody is not provided.'});
  await writeFile(files.sidecarPath,JSON.stringify(sidecar,null,2));
  assert.equal(sidecar.manifestDigest,backupManifestDigest(body));
  assert.equal(JSON.stringify(sidecar).includes(SECRET),false);
  assert.equal(JSON.stringify(sidecar).includes('manifestDigest'),true);
  const header=producer.encryptedBackupHeader(body.backupId,'AQIDBAUGBwgJCgsMDQ4P');
  assert.equal(header.includes('manifestDigest'),false);
  assert.equal(header,'{"schemaVersion":1,"backupId":"'+body.backupId+'","algorithm":"aes-256-gcm","iv":"AQIDBAUGBwgJCgsMDQ4P"}\n');
  assert.deepEqual(await readFile(files.archivePath),before);
  const source=await readFile(new URL('../scripts/backup-lab.mjs',import.meta.url),'utf8');
  assert.match(source,/backupArchiveSidecarFromProducer\(manifest,/);
  assert.match(source,/encryptedBackupHeader\(backupId,iv\.toString\('base64'\)\)/);
  assert.match(source,/writeFile\(archive\+'\.json'/);
  const apto=run(['--manifest',files.manifestPath,'--observation',files.observationPath,'--effects',files.effectsPath,'--digest-file',files.sidecarPath]);
  assert.equal(apto.status,RESTORE_VERIFY_EXIT_APTO);
  assert.equal(apto.status,0);
  const aptoReport=JSON.parse(apto.stdout);
  assert.equal(aptoReport.verdict,'apto');
  assert.equal(aptoReport.performedRestore,false);
  assert.equal(aptoReport.authorizesAdmission,false);
  assert.equal(aptoReport.authorizesRepeat,false);
  assert.equal(JSON.stringify(aptoReport),JSON.stringify(verifyRestore({manifest:body,observed:observed(),externalEffects:[],expectedManifestDigest:sidecar.manifestDigest})));
  assert.equal(JSON.stringify(aptoReport).includes(SECRET),false);
  const parcialObservation=join(files.dir,'parcial.json');
  await writeFile(parcialObservation,JSON.stringify({schemaVersion:1,database:{version:1,digest:DATABASE}}));
  const parcial=run(['--manifest',files.manifestPath,'--observation',parcialObservation,'--effects',files.effectsPath,'--digest',String(sidecar.manifestDigest)]);
  assert.equal(parcial.status,RESTORE_VERIFY_EXIT_PARCIAL);
  assert.equal(parcial.status,2);
  assert.notEqual(parcial.status,0);
  assert.equal(JSON.parse(parcial.stdout).verdict,'parcial');
  assert.equal(JSON.parse(parcial.stdout).reason,'componente_ausente');
  const divergent=run(['--manifest',files.manifestPath,'--observation',files.observationPath,'--effects',files.effectsPath,'--digest','ab'.repeat(32)]);
  assert.equal(divergent.status,RESTORE_VERIFY_EXIT_INAPTO);
  assert.equal(divergent.status,3);
  assert.notEqual(divergent.status,0);
  assert.equal(JSON.parse(divergent.stdout).verdict,'inapto');
  assert.equal(JSON.parse(divergent.stdout).reason,'digest_divergente');
  const absent=run(['--manifest',files.manifestPath,'--observation',files.observationPath,'--effects',files.effectsPath]);
  assert.equal(absent.status,RESTORE_VERIFY_EXIT_INAPTO);
  assert.notEqual(absent.status,0);
  assert.equal(JSON.parse(absent.stdout).verdict,'inapto');
  assert.equal(JSON.parse(absent.stdout).reason,'integridade do manifesto não comprovada');
  const emptyProof=join(files.dir,'empty-digest.txt');
  await writeFile(emptyProof,'');
  const empty=run(['--manifest',files.manifestPath,'--observation',files.observationPath,'--effects',files.effectsPath,'--digest-file',emptyProof]);
  assert.equal(empty.status,3);
  assert.equal(JSON.parse(empty.stdout).reason,'integridade do manifesto não comprovada');
  const sidecarWithout=join(files.dir,'without.json');
  await writeFile(sidecarWithout,JSON.stringify({scope:body.scope,archive:files.archivePath}));
  const missingField=run(['--manifest',files.manifestPath,'--observation',files.observationPath,'--effects',files.effectsPath,'--digest-file',sidecarWithout]);
  assert.equal(missingField.status,3);
  assert.notEqual(JSON.parse(missingField.stdout).verdict,'apto');
  assert.equal(JSON.parse(missingField.stdout).reason,'integridade do manifesto não comprovada');
  const truncatedPath=join(files.dir,'truncated.json');
  await writeFile(truncatedPath,'{');
  const truncated=run(['--manifest',truncatedPath,'--observation',files.observationPath,'--effects',files.effectsPath,'--digest',String(sidecar.manifestDigest)]);
  assert.equal(truncated.status,3);
  assert.equal(JSON.parse(truncated.stdout).verdict,'inapto');
  assert.equal(JSON.parse(truncated.stdout).reason,'manifesto_truncado');
  const effects=join(files.dir,'posterior.json');
  await writeFile(effects,JSON.stringify([{kind:'job',id:'22222222-2222-4222-8222-222222222222',createdAt:AFTER}]));
  const posterior=run(['--manifest',files.manifestPath,'--observation',files.observationPath,'--effects',effects,'--digest-file',files.sidecarPath]);
  assert.equal(posterior.status,2);
  assert.notEqual(posterior.status,0);
  const posteriorReport=JSON.parse(posterior.stdout);
  assert.equal(posteriorReport.verdict,'parcial');
  assert.equal(posteriorReport.reason,'efeito_externo_posterior');
  assert.equal(posteriorReport.externalEffects.classification,'incerto');
  assert.equal(posteriorReport.externalEffects.reconciliationRequired,true);
  assert.equal(posteriorReport.externalEffects.safeToRepeat,false);
  assert.equal(posteriorReport.externalEffects.effects[0].classification,'incerto');
  assert.equal(posteriorReport.authorizesRepeat,false);
  const usage=run(['--manifest',files.manifestPath]);
  assert.equal(usage.status,RESTORE_VERIFY_EXIT_USAGE);
  assert.equal(usage.status,1);
  assert.equal(usage.stdout,'');
  const both=run(['--manifest',files.manifestPath,'--observation',files.observationPath,'--digest','ab'.repeat(32),'--digest-file',files.sidecarPath]);
  assert.equal(both.status,1);
  assert.deepEqual(await readFile(files.archivePath),before);
 }finally{await files.cleanup();}
});

test('a função extraída do produtor, sem Docker, grava o mesmo digest que o verificador',async()=>{
 const body=manifest();
 const plain=spawnSync(process.execPath,['--input-type=module','-e',
  `import {backupArchiveSidecarFromProducer,encryptedBackupHeader} from './scripts/backup-lab.mjs';
   const manifest=${JSON.stringify(body)};
   const sidecar=await backupArchiveSidecarFromProducer(manifest,{scope:manifest.scope,archive:'/tmp/archive.acbackup',tagFile:'/tmp/archive.acbackup.tag',keyFile:'/tmp/archive.acbackup.key',sha256:'${'ab'.repeat(32)}',sourceFiles:4,size:3,warning:'local'});
   if(sidecar.manifestDigest!==${JSON.stringify(backupManifestDigest(body))})throw new Error('DIGEST_MISMATCH');
   if(JSON.stringify(sidecar).includes(${JSON.stringify(SECRET)}))throw new Error('SECRET_LEAKED');
   const header=encryptedBackupHeader('id','iv');
   if(header.includes('manifestDigest'))throw new Error('HEADER_CHANGED');
   process.stdout.write(sidecar.manifestDigest);`],{encoding:'utf8',cwd:root});
 assert.equal(plain.status,0,plain.stderr);
 assert.equal(plain.stdout,backupManifestDigest(body));
 const report=verifyRestore({manifest:body,observed:observed(),externalEffects:[],expectedManifestDigest:plain.stdout});
 assert.equal(report.verdict,'apto');
});
