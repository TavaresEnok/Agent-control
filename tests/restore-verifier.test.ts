import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {digest} from '../src/contracts.ts';
import {backupManifestDigest,RESTORE_COMPONENTS,RESTORE_EXTERNAL_EFFECT_LIMIT,RESTORE_MANIFEST_SCOPE,verifyRestore,type RestoreVerification} from '../src/restore-verifier.ts';

const CREATED='2026-11-03T12:00:00.000Z';
const BEFORE='2026-11-03T11:59:59.999Z';
const BETWEEN='2026-11-03T12:30:00.000Z';
const LATER_CUTOFF='2026-11-03T13:00:00.000Z';
const AFTER='2026-11-03T12:00:00.001Z';
const SECRET='SECRET_PATH_/etc/passwd token=do-not-leak';
const DATABASE='c'.repeat(64);
const FILES=[
 {path:'.state/keys/lab-key',size:4,sha256:'11'.repeat(32)},
 {path:'.state/happier/server.sqlite',size:8,sha256:'22'.repeat(32)},
 {path:'.state/browser-fixture.json',size:12,sha256:'33'.repeat(32)},
 {path:'.state/projects/plan.json',size:16,sha256:'44'.repeat(32)},
];

function producerManifest(patch?:Record<string,unknown>){
 return {schemaVersion:1,scope:RESTORE_MANIFEST_SCOPE,backupId:'2026-11-03T12-00-00-000Z-ab12cd34',root:SECRET,createdAt:CREATED,
  commit:'a'.repeat(40),sources:['.state/happier','.state/projects','.state/browser-fixture.json','.state/keys'],missingOptional:[],
  files:FILES.map(file=>({...file})),databaseSha256:DATABASE,limitation:'Requires the same isolated root for absolute Git worktree links. No production restore/admission is authorized.',
  ...patch};
}
function observed(patch?:{database?:unknown;files?:unknown;schemaVersion?:unknown;versions?:unknown}){
 return {schemaVersion:1,database:{version:1,digest:DATABASE},versions:{vault:1,context:1,ui_state:1,plan_receipts:1},files:FILES.map(file=>({...file})),...patch};
}
function effect(kind:'job'|'grant'|'receipt',id:string,createdAt:string){
 return {kind,id,createdAt,safeToRepeat:true,note:SECRET};
}
function verify(patch?:{manifest?:unknown;manifestTruncated?:boolean;observed?:unknown;externalEffects?:unknown;expectedManifestDigest?:unknown}):RestoreVerification{
 const body:Record<string,unknown>={manifest:producerManifest(),observed:observed(),externalEffects:[],...patch};
 if(!patch||!Object.prototype.hasOwnProperty.call(patch,'expectedManifestDigest')){
  const manifest=body.manifest;
  if(manifest!==null&&typeof manifest==='object'&&!Array.isArray(manifest))body.expectedManifestDigest=backupManifestDigest({...manifest});
 }
 return verifyRestore(body);
}
function ids(report:RestoreVerification){return report.components.map(component=>`${component.id}:${component.verdict}:${component.reason}`);}

test('a backup-lab manifest with matching components and a closed inventory is apto and deterministic',()=>{
 const gap=[
  effect('receipt','55555555-5555-4555-8555-555555555555',CREATED),
  effect('job','22222222-2222-4222-8222-222222222222',BEFORE),
  effect('grant','33333333-3333-4333-8333-333333333333',BEFORE),
 ];
 const forward=verify({externalEffects:[]});
 const manifest=producerManifest();
 const reversedManifest={limitation:manifest.limitation,databaseSha256:manifest.databaseSha256,files:[...manifest.files].reverse(),missingOptional:manifest.missingOptional,
  sources:[...manifest.sources].reverse(),commit:manifest.commit,createdAt:manifest.createdAt,root:manifest.root,backupId:manifest.backupId,scope:manifest.scope,schemaVersion:manifest.schemaVersion};
 const backward=verifyRestore({externalEffects:[],observed:{files:[...FILES].reverse(),database:{digest:DATABASE,version:1},versions:{plan_receipts:1,ui_state:1,context:1,vault:1},schemaVersion:1},manifest:reversedManifest,expectedManifestDigest:backupManifestDigest(reversedManifest)});
 assert.equal(forward.verdict,'apto');
 assert.equal(forward.reason,'componente_conferido');
 assert.deepEqual(ids(forward),RESTORE_COMPONENTS.map(id=>`${id}:apto:componente_conferido`));
 assert.equal(forward.externalEffects.inventory,'fechado');
 assert.equal(forward.externalEffects.classification,'nenhum_posterior');
 assert.equal(forward.externalEffects.reconciliationRequired,false);
 assert.equal(forward.externalEffects.safeToRepeat,false);
 assert.equal(forward.performedRestore,false);
 assert.equal(forward.authorizesAdmission,false);
 assert.equal(forward.authorizesRepeat,false);
 assert.equal(forward.externalEffects.effects.length,0);
 assert.equal(JSON.stringify(forward),JSON.stringify(backward));
 assert.equal(JSON.stringify(forward),JSON.stringify(verifyRestore(JSON.parse(JSON.stringify({manifest:producerManifest(),observed:observed(),externalEffects:[],expectedManifestDigest:backupManifestDigest(producerManifest())})))));
 const gapReport=verify({externalEffects:gap});
 const gapBackward=verifyRestore({externalEffects:[...gap].reverse(),observed:{files:[...FILES].reverse(),database:{digest:DATABASE,version:1},versions:{vault:1,context:1,ui_state:1,plan_receipts:1},schemaVersion:1},manifest:reversedManifest,expectedManifestDigest:backupManifestDigest(reversedManifest)});
 assert.equal(gapReport.verdict,'parcial');
 assert.notEqual(gapReport.verdict,'apto');
 assert.equal(gapReport.reason,'efeito_externo_sem_corte');
 assert.equal(gapReport.externalEffects.classification,'incerto');
 assert.equal(gapReport.externalEffects.reconciliationRequired,true);
 assert.equal(gapReport.externalEffects.safeToRepeat,false);
 assert.equal(gapReport.authorizesRepeat,false);
 assert.deepEqual(gapReport.externalEffects.effects.map(item=>item.kind),['job','grant','receipt']);
 assert.ok(gapReport.externalEffects.effects.every(item=>item.classification==='incerto'&&item.safeToRepeat===false&&item.reconciliationRequired===true&&item.reason==='efeito_externo_sem_corte'));
 assert.equal(JSON.stringify(gapReport),JSON.stringify(gapBackward));
 const sealed={...producerManifest(),digest:backupManifestDigest(producerManifest())};
 assert.equal(sealed.digest,digest(producerManifest()));
 assert.equal(verify({manifest:sealed}).verdict,'apto');
 assert.equal(JSON.stringify(forward).includes(SECRET),false);
 assert.equal(JSON.stringify(forward).includes('ab12cd34'),false);
 assert.equal(JSON.stringify(forward).includes('server.sqlite'),false);
 assert.equal(JSON.stringify(forward).includes(DATABASE),false);
});

test('the existing backup manifest is accepted, and a missing, truncated, or divergent manifest is inapto',()=>{
 const preview={schemaVersion:1,scope:'isolated-synthetic-lab',backupId:'synthetic-backup',root:SECRET,createdAt:CREATED,commit:'a'.repeat(40),sources:['.state/happier'],missingOptional:['.state/keys'],files:[{path:'.state/happier/private-file',size:12,sha256:'b'.repeat(64)}],databaseSha256:DATABASE,limitation:'synthetic only'};
 const previewReport=verify({manifest:preview,observed:observed({files:preview.files,database:{digest:DATABASE,version:1}})});
 assert.notEqual(previewReport.reason,'manifesto_truncado');
 assert.equal(previewReport.verdict,'parcial');
 assert.equal(previewReport.reason,'componente_ausente');
 assert.equal(previewReport.components.find(component=>component.id==='database')?.verdict,'apto');
 assert.equal(previewReport.components.find(component=>component.id==='context')?.verdict,'apto');
 assert.equal(previewReport.components.find(component=>component.id==='vault')?.reason,'componente_ausente');
 assert.equal(previewReport.components.find(component=>component.id==='ui_state')?.reason,'componente_ausente');
 assert.equal(previewReport.components.find(component=>component.id==='plan_receipts')?.reason,'componente_ausente');
 assert.equal(JSON.stringify(previewReport).includes(SECRET),false);
 assert.equal(JSON.stringify(previewReport).includes('private-file'),false);
 const portable={schemaVersion:1,kind:'agent_control_portable_metadata_v1',restorable:false,conversationIncluded:false,truncated:false,digest:'ab'.repeat(32)};
 const portableReport=verify({manifest:portable});
 assert.equal(portableReport.verdict,'inapto');
 assert.equal(portableReport.reason,'manifesto_truncado');
 const absent=verifyRestore({manifest:null,observed:observed(),externalEffects:[],expectedManifestDigest:'ab'.repeat(32)});
 assert.equal(absent.verdict,'inapto');
 assert.equal(absent.reason,'manifesto_ausente');
 assert.ok(absent.components.every(component=>component.verdict==='inapto'&&component.reason==='manifesto_ausente'));
 const cutFlag=verifyRestore({manifest:null,manifestTruncated:true,observed:observed(),externalEffects:[],expectedManifestDigest:'ab'.repeat(32)});
 assert.equal(cutFlag.reason,'manifesto_truncado');
 assert.equal(cutFlag.verdict,'inapto');
 const unsafe=verify({manifest:producerManifest({files:[...FILES,{path:'../../secret',size:1,sha256:'d'.repeat(64)}]})});
 assert.equal(unsafe.reason,'manifesto_truncado');
 assert.equal(JSON.stringify(unsafe).includes('secret'),false);
 const duplicate=verify({manifest:producerManifest({files:[FILES[0],FILES[0]]})});
 assert.equal(duplicate.reason,'manifesto_truncado');
 const mismatched=producerManifest({digest:'ab'.repeat(32)});
 const diverged=verify({manifest:mismatched});
 assert.equal(diverged.verdict,'inapto');
 assert.equal(diverged.reason,'digest_divergente');
 assert.ok(diverged.components.every(component=>component.reason==='digest_divergente'&&component.verdict==='inapto'));
 const extra=verify({manifest:producerManifest({note:SECRET})});
 assert.equal(extra.reason,'manifesto_truncado');
 assert.equal(JSON.stringify(extra).includes('SECRET_PATH'),false);
 const omitted=verifyRestore({expectedManifestDigest:'cd'.repeat(32)});
 assert.equal(omitted.reason,'manifesto_ausente');
 assert.equal(omitted.externalEffects.reason,'inventario_externo_ausente');
 assert.equal(omitted.externalEffects.classification,'incerto');
 const schema=verify({manifest:producerManifest({schemaVersion:2})});
 assert.equal(schema.verdict,'inapto');
 assert.equal(schema.reason,'versao_incompativel');
});

test('component absence is parcial and a divergent or incompatible component is inapto',()=>{
 const missingVault=verify({observed:observed({files:FILES.filter(file=>!file.path.startsWith('.state/keys/'))})});
 assert.equal(missingVault.verdict,'parcial');
 assert.equal(missingVault.reason,'componente_ausente');
 assert.equal(missingVault.components.find(component=>component.id==='vault')?.verdict,'parcial');
 assert.ok(missingVault.components.filter(component=>component.id!=='vault').every(component=>component.verdict==='apto'));
 const none=verify({observed:{}});
 assert.equal(none.verdict,'parcial');
 assert.ok(none.components.every(component=>component.reason==='componente_ausente'));
 const wrongDigest=verify({observed:observed({database:{version:1,digest:'99'.repeat(32)}})});
 assert.equal(wrongDigest.verdict,'inapto');
 assert.equal(wrongDigest.reason,'digest_divergente');
 assert.equal(wrongDigest.components[0]?.verdict,'inapto');
 assert.equal(wrongDigest.components[1]?.verdict,'apto');
 const wrongFile=verify({observed:observed({files:FILES.map(file=>file.path.endsWith('server.sqlite')?{...file,sha256:'99'.repeat(32)}:file)})});
 assert.equal(wrongFile.verdict,'inapto');
 assert.equal(wrongFile.components.find(component=>component.id==='context')?.reason,'digest_divergente');
 const badVersion=verify({observed:observed({schemaVersion:2})});
 assert.equal(badVersion.verdict,'inapto');
 assert.equal(badVersion.reason,'versao_incompativel');
 const manifestVersion=verify({observed:observed({versions:{vault:1,context:1,ui_state:1,plan_receipts:2}})});
 assert.equal(manifestVersion.verdict,'inapto');
 assert.equal(manifestVersion.components.find(component=>component.id==='plan_receipts')?.reason,'versao_incompativel');
 assert.equal(manifestVersion.components.find(component=>component.id==='database')?.verdict,'apto');
 const omittedSchema=verify({observed:{database:{digest:DATABASE},files:FILES.map(file=>({...file}))}});
 assert.equal(omittedSchema.verdict,'inapto');
 assert.equal(omittedSchema.reason,'versao_incompativel');
 assert.ok(omittedSchema.components.every(component=>component.verdict==='inapto'&&component.reason==='versao_incompativel'));
 const envelopeOnly=verify({observed:{schemaVersion:1,database:{digest:DATABASE,version:1},files:FILES.map(file=>({...file}))}});
 assert.equal(envelopeOnly.verdict,'inapto');
 assert.equal(envelopeOnly.reason,'versao_incompativel');
 assert.equal(envelopeOnly.components.find(component=>component.id==='database')?.verdict,'apto');
 assert.ok(envelopeOnly.components.filter(component=>component.id!=='database').every(component=>component.reason==='versao_incompativel'));
 const noDatabaseVersion=verify({observed:observed({database:{digest:DATABASE}})});
 assert.equal(noDatabaseVersion.verdict,'inapto');
 assert.equal(noDatabaseVersion.components.find(component=>component.id==='database')?.reason,'versao_incompativel');
 assert.equal(noDatabaseVersion.components.find(component=>component.id==='vault')?.verdict,'apto');
});

test('effects after the backup are uncertain, and a cutoff after createdAt is never apto',()=>{
 const later=[
  effect('receipt','77777777-7777-4777-8777-777777777777',AFTER),
  effect('grant','66666666-6666-4666-8666-666666666666',AFTER),
  effect('job','88888888-8888-4888-8888-888888888888',AFTER),
 ];
 const report=verify({externalEffects:later});
 assert.equal(report.verdict,'parcial');
 assert.notEqual(report.verdict,'apto');
 assert.equal(report.reason,'efeito_externo_posterior');
 assert.equal(report.externalEffects.classification,'incerto');
 assert.equal(report.externalEffects.reconciliationRequired,true);
 assert.equal(report.externalEffects.safeToRepeat,false);
 assert.deepEqual(report.externalEffects.effects.map(item=>item.kind),['job','grant','receipt']);
 assert.ok(report.externalEffects.effects.every(item=>item.classification==='incerto'&&item.safeToRepeat===false&&item.reconciliationRequired===true&&item.reason==='efeito_externo_posterior'));
 assert.equal(JSON.stringify(report).includes('safeToRepeat":true'),false);
 const lateCutoff=verify({manifest:producerManifest({cutoff:LATER_CUTOFF}),externalEffects:[effect('job','22222222-2222-4222-8222-222222222222',BETWEEN)]});
 assert.equal(lateCutoff.verdict,'inapto');
 assert.notEqual(lateCutoff.verdict,'apto');
 assert.equal(lateCutoff.reason,'corte_posterior_ao_backup');
 assert.ok(lateCutoff.components.every(component=>component.verdict==='inapto'&&component.reason==='corte_posterior_ao_backup'));
 assert.equal(lateCutoff.externalEffects.effects[0]?.classification,'incerto');
 assert.equal(lateCutoff.externalEffects.effects[0]?.reason,'efeito_externo_posterior');
 const lateWithEarlier=verify({manifest:producerManifest({cutoff:LATER_CUTOFF}),externalEffects:[effect('grant','33333333-3333-4333-8333-333333333333',BEFORE)]});
 assert.equal(lateWithEarlier.verdict,'inapto');
 assert.equal(lateWithEarlier.externalEffects.effects[0]?.classification,'incerto');
 assert.equal(lateWithEarlier.externalEffects.effects[0]?.reason,'efeito_externo_sem_corte');
 assert.equal(lateWithEarlier.externalEffects.effects[0]?.reconciliationRequired,true);
 assert.equal(lateWithEarlier.externalEffects.effects[0]?.safeToRepeat,false);
 assert.equal(lateCutoff.externalEffects.effects[0]?.reconciliationRequired,true);
 assert.equal(lateCutoff.externalEffects.effects[0]?.safeToRepeat,false);
 assert.equal(lateCutoff.externalEffects.reconciliationRequired,true);
 assert.equal(lateCutoff.authorizesRepeat,false);
 const earlyBound=verify({manifest:producerManifest({createdAt:LATER_CUTOFF,cutoff:CREATED}),externalEffects:[effect('job','22222222-2222-4222-8222-222222222222',BETWEEN)]});
 assert.equal(earlyBound.verdict,'parcial');
 assert.notEqual(earlyBound.verdict,'apto');
 assert.equal(earlyBound.externalEffects.effects[0]?.classification,'incerto');
 assert.equal(earlyBound.externalEffects.effects[0]?.reason,'efeito_externo_posterior');
 assert.equal(earlyBound.externalEffects.effects[0]?.safeToRepeat,false);
 const atExplicitCutoff=verify({manifest:producerManifest({createdAt:LATER_CUTOFF,cutoff:CREATED}),externalEffects:[effect('job','22222222-2222-4222-8222-222222222222',CREATED),effect('grant','33333333-3333-4333-8333-333333333333',BEFORE)]});
 assert.equal(atExplicitCutoff.verdict,'parcial');
 assert.notEqual(atExplicitCutoff.verdict,'apto');
 assert.ok(atExplicitCutoff.externalEffects.effects.every(item=>item.classification==='incerto'&&item.reason==='efeito_externo_sem_corte'&&item.reconciliationRequired===true&&item.safeToRepeat===false));
 const unknown=verifyRestore({manifest:producerManifest(),observed:observed(),expectedManifestDigest:backupManifestDigest(producerManifest())});
 assert.equal(unknown.verdict,'parcial');
 assert.equal(unknown.externalEffects.inventory,'ausente');
 assert.equal(unknown.externalEffects.classification,'incerto');
 assert.equal(unknown.authorizesRepeat,false);
 const explicitNull=verify({externalEffects:null});
 assert.equal(explicitNull.externalEffects.reason,'inventario_externo_ausente');
 assert.notEqual(explicitNull.verdict,'apto');
 const invalidTime=verify({externalEffects:[effect('job','99999999-9999-4999-8999-999999999999','2026-11-03T12:00:00Z')]});
 assert.equal(invalidTime.verdict,'parcial');
 assert.equal(invalidTime.externalEffects.effects[0]?.classification,'incerto');
 assert.equal(invalidTime.externalEffects.effects[0]?.reason,'efeito_externo_tempo_invalido');
 assert.equal(invalidTime.externalEffects.effects[0]?.safeToRepeat,false);
 const duplicate=verify({externalEffects:[effect('job','22222222-2222-4222-8222-222222222222',BEFORE),effect('grant','22222222-2222-4222-8222-222222222222',AFTER)]});
 assert.equal(duplicate.externalEffects.inventory,'invalido');
 assert.equal(duplicate.externalEffects.effects.length,0);
 assert.equal(duplicate.verdict,'parcial');
 assert.equal(duplicate.externalEffects.safeToRepeat,false);
 const overflow=verify({externalEffects:Array.from({length:RESTORE_EXTERNAL_EFFECT_LIMIT+1},(_,index)=>effect('job',`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,BEFORE))});
 assert.equal(overflow.externalEffects.inventory,'invalido');
 assert.notEqual(overflow.verdict,'apto');
 const atCutoff=verify({externalEffects:[effect('grant','33333333-3333-4333-8333-333333333333',CREATED)]});
 assert.equal(atCutoff.verdict,'parcial');
 assert.notEqual(atCutoff.verdict,'apto');
 assert.equal(atCutoff.externalEffects.effects[0]?.classification,'incerto');
 assert.equal(atCutoff.externalEffects.effects[0]?.reason,'efeito_externo_sem_corte');
 assert.equal(atCutoff.externalEffects.effects[0]?.reconciliationRequired,true);
 assert.equal(atCutoff.externalEffects.effects[0]?.safeToRepeat,false);
 const beforeCreated=verify({externalEffects:[effect('job','22222222-2222-4222-8222-222222222222',BEFORE)]});
 assert.equal(beforeCreated.verdict,'parcial');
 assert.notEqual(beforeCreated.verdict,'apto');
 assert.equal(beforeCreated.externalEffects.effects[0]?.classification,'incerto');
 assert.equal(beforeCreated.externalEffects.effects[0]?.reason,'efeito_externo_sem_corte');
 assert.equal(beforeCreated.externalEffects.effects[0]?.reconciliationRequired,true);
 assert.equal(beforeCreated.externalEffects.effects[0]?.safeToRepeat,false);
 const untrusted=verify({manifest:producerManifest({schemaVersion:2}),externalEffects:[effect('job','22222222-2222-4222-8222-222222222222',BEFORE)]});
 assert.equal(untrusted.verdict,'inapto');
 assert.equal(untrusted.externalEffects.effects[0]?.classification,'incerto');
 assert.equal(untrusted.externalEffects.effects[0]?.reason,'efeito_externo_sem_corte');
 assert.equal(untrusted.externalEffects.effects[0]?.safeToRepeat,false);
});

test('a valid truncated manifest is inapto unless the independent registered digest matches the body received',()=>{
 const extra={path:'.state/happier/sessions.sqlite',size:9,sha256:'55'.repeat(32)};
 const intactFiles=[...FILES,extra];
 const intact=producerManifest({files:intactFiles});
 const registered=backupManifestDigest(intact);
 const truncatedFiles=intactFiles.filter(file=>file.path!==extra.path);
 const truncated=producerManifest({files:truncatedFiles});
 assert.notEqual(backupManifestDigest(truncated),registered);
 const matchedToTruncation=verify({manifest:truncated,observed:observed({files:truncatedFiles}),expectedManifestDigest:registered});
 assert.equal(matchedToTruncation.verdict,'inapto');
 assert.notEqual(matchedToTruncation.verdict,'apto');
 assert.notEqual(matchedToTruncation.verdict,'parcial');
 assert.equal(matchedToTruncation.reason,'digest_divergente');
 assert.ok(matchedToTruncation.components.every(component=>component.verdict==='inapto'&&component.reason==='digest_divergente'));
 const missing=verifyRestore({manifest:intact,observed:observed({files:intactFiles}),externalEffects:[],expectedManifestDigest:undefined});
 assert.equal(missing.verdict,'inapto');
 assert.notEqual(missing.verdict,'apto');
 assert.notEqual(missing.verdict,'parcial');
 assert.equal(missing.reason,'integridade do manifesto não comprovada');
 assert.ok(missing.components.every(component=>component.verdict==='inapto'&&component.reason==='integridade do manifesto não comprovada'));
 const omittedProof=verify({manifest:intact,observed:observed({files:intactFiles}),expectedManifestDigest:undefined});
 assert.equal(omittedProof.reason,'integridade do manifesto não comprovada');
 assert.equal(omittedProof.verdict,'inapto');
 const sealedOnly=verifyRestore({manifest:{...intact,digest:registered},observed:observed({files:intactFiles}),externalEffects:[]});
 assert.equal(sealedOnly.verdict,'inapto');
 assert.equal(sealedOnly.reason,'integridade do manifesto não comprovada');
 const divergent=verify({manifest:intact,observed:observed({files:intactFiles}),expectedManifestDigest:'ab'.repeat(32)});
 assert.equal(divergent.verdict,'inapto');
 assert.equal(divergent.reason,'digest_divergente');
 assert.ok(divergent.components.every(component=>component.reason==='digest_divergente'));
 const blank=verify({expectedManifestDigest:''});
 assert.equal(blank.verdict,'inapto');
 assert.equal(blank.reason,'integridade do manifesto não comprovada');
 const proven=verify({manifest:intact,observed:observed({files:intactFiles}),expectedManifestDigest:registered});
 assert.equal(proven.verdict,'apto');
 assert.equal(proven.reason,'componente_conferido');
 assert.equal(backupManifestDigest(intact),digest(intact));
});

test('the verifier stays in memory and keeps a fixed component order',()=>{
 const source=readFileSync(new URL('../src/restore-verifier.ts',import.meta.url),'utf8');
 assert.equal(source.includes('node:fs'),false);
 assert.equal(source.includes('node:pg'),false);
 assert.equal(source.includes("from 'pg'"),false);
 assert.equal(source.includes('child_process'),false);
 assert.equal(source.includes('Date.now'),false);
 assert.equal(source.includes('docker'),false);
 assert.match(source,/from '\.\/contracts\.ts'/);
 assert.match(source,/isolated-synthetic-lab/);
 const report=verify();
 assert.deepEqual(report.components.map(component=>component.id),[...RESTORE_COMPONENTS]);
 assert.equal(report.schemaVersion,1);
 assert.equal(report.kind,'restore_verification');
});
