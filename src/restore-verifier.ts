import {digest} from './contracts.ts';

/** In-memory check of a described restore against the backup manifest written by
 * `scripts/backup-lab.mjs` (scope `isolated-synthetic-lab`). This module does not
 * read a database, archive, vault, or host. It never restores, admits work, or
 * authorizes repeating an external effect.
 * A missing, truncated, or digest-mismatched manifest is unfit. The caller must
 * pass `expectedManifestDigest`, the canonical digest registered outside the
 * manifest at backup time. Absence of that proof is unfit
 * (`integridade do manifesto não comprovada`). A different value is unfit.
 * The optional `digest` field inside the manifest does not replace that proof.
 * `scripts/backup-lab.mjs` does not record it yet. `createdAt` is
 * written after the file scan and `pg_dump`, so it is only a posterior threshold.
 * A cutoff later than `createdAt` is unfit. No field of this manifest is a cut
 * proven to precede the snapshot: a job, grant, or receipt is uncertain and
 * requires reconciliation. Component versions must be present on the observation;
 * the manifest `schemaVersion` describes the manifest format only. */
export const RESTORE_VERIFIER_VERSION=1 as const;
export const RESTORE_COMPONENTS=['database','vault','context','ui_state','plan_receipts'] as const;
export type RestoreComponentId=(typeof RESTORE_COMPONENTS)[number];
export const EXTERNAL_EFFECT_KINDS=['job','grant','receipt'] as const;
export type ExternalEffectKind=(typeof EXTERNAL_EFFECT_KINDS)[number];
export const SUPPORTED_SCHEMA_VERSION=1 as const;
export const RESTORE_EXTERNAL_EFFECT_LIMIT=256 as const;
export const RESTORE_MANIFEST_SCOPE='isolated-synthetic-lab' as const;
/** Same byte ceiling as `BACKUP_MANIFEST_LIMIT` in the backup preview. */
export const RESTORE_MANIFEST_BYTE_LIMIT=192*1024;
const FILE_LIMIT=2000;
const LIST_LIMIT=100;
const BYTE_LIMIT=1024*1024*1024;
const TEXT_LIMIT=4096;

export type RestoreVerdict='apto'|'parcial'|'inapto';
export type RestoreReason=
  |'manifesto_ausente'
  |'manifesto_truncado'
  |'integridade do manifesto não comprovada'
  |'digest_divergente'
  |'versao_incompativel'
  |'corte_posterior_ao_backup'
  |'componente_ausente'
  |'componente_conferido'
  |'efeito_externo_posterior'
  |'efeito_externo_tempo_invalido'
  |'efeito_externo_sem_corte'
  |'inventario_externo_ausente'
  |'inventario_externo_invalido'
  |'inventario_externo_fechado';

export type ComponentVerification={id:RestoreComponentId;verdict:RestoreVerdict;reason:RestoreReason};
export type EffectVerification={
  kind:ExternalEffectKind;
  id:string;
  classification:'incerto';
  reconciliationRequired:boolean;
  safeToRepeat:false;
  reason:Extract<RestoreReason,'efeito_externo_posterior'|'efeito_externo_tempo_invalido'|'efeito_externo_sem_corte'>;
};
export type ExternalEffectReport={
  inventory:'fechado'|'ausente'|'invalido';
  classification:'nenhum_posterior'|'incerto';
  reconciliationRequired:boolean;
  safeToRepeat:false;
  reason:RestoreReason;
  effects:EffectVerification[];
};
export type RestoreVerification={
  schemaVersion:1;
  kind:'restore_verification';
  verifierVersion:1;
  verdict:RestoreVerdict;
  reason:RestoreReason;
  components:ComponentVerification[];
  externalEffects:ExternalEffectReport;
  performedRestore:false;
  authorizesAdmission:false;
  authorizesRepeat:false;
};

const HEX=/^[a-f0-9]{64}$/;
const INSTANT=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT=/^[a-f0-9]{40,64}$/;
const REQUIRED_KEYS=['schemaVersion','scope','backupId','root','createdAt','commit','sources','missingOptional','files','databaseSha256','limitation'] as const;
const OPTIONAL_KEYS=['cutoff','digest'] as const;
const FILE_KEYS=['path','size','sha256'] as const;
const EFFECT_KIND_ORDER=new Map(EXTERNAL_EFFECT_KINDS.map((kind,index)=>[kind,index]));
type FileComponent=Exclude<RestoreComponentId,'database'>;
const FILE_COMPONENTS:readonly FileComponent[]=['vault','context','ui_state','plan_receipts'];

type Plain=Record<string,unknown>;
type ManifestFailure='manifesto_ausente'|'manifesto_truncado'|'integridade do manifesto não comprovada'|'digest_divergente'|'versao_incompativel'|'corte_posterior_ao_backup';
type FileRec={path:string;size:number;sha256:string};
type VersionState='ok'|'bad'|'missing';
type ParsedManifest={ok:false;reason:ManifestFailure;posteriorAfter:number|null}|{ok:true;posteriorAfter:number;databaseDigest:string;files:Record<FileComponent,FileRec[]>};
type ObservedFiles=FileRec[]|null|'invalid';
type Observed={
  present:boolean;
  schema:VersionState;
  database:{digest:string;version:VersionState}|null;
  versions:Record<FileComponent,VersionState>;
  files:ObservedFiles;
};
type EffectDraft={kind:ExternalEffectKind;id:string;createdAt:string;at:number|null};

function isPlain(value:unknown):value is Plain{
 return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function safePath(value:unknown):value is string{
 if(typeof value!=='string'||value.length<1||value.length>TEXT_LIMIT||value.startsWith('/')||value.includes('\\'))return false;
 return value.split('/').every(part=>part.length>0&&part!=='.'&&part!=='..');
}
function parseInstant(value:unknown){
 if(typeof value!=='string'||!INSTANT.test(value))return null;
 const ms=Date.parse(value);
 if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)return null;
 return ms;
}
function integer(value:unknown){
 return typeof value==='number'&&Number.isInteger(value)?value:null;
}
function versionState(value:unknown):VersionState{
 if(value===undefined)return 'missing';
 return value===SUPPORTED_SCHEMA_VERSION?'ok':'bad';
}
function componentForPath(path:string):FileComponent|null{
 if(path==='.state/keys'||path.startsWith('.state/keys/'))return 'vault';
 if(path==='.state/happier'||path.startsWith('.state/happier/'))return 'context';
 if(path==='.state/browser-fixture.json')return 'ui_state';
 if(path==='.state/projects'||path.startsWith('.state/projects/'))return 'plan_receipts';
 return null;
}
function coveredBySource(path:string,source:string){
 return path===source||path.startsWith(source+'/');
}
function sameFiles(expected:readonly FileRec[],actual:readonly FileRec[]){
 if(expected.length!==actual.length)return false;
 const order=(left:FileRec,right:FileRec)=>left.path<right.path?-1:left.path>right.path?1:0;
 const left=[...expected].sort(order);
 const right=[...actual].sort(order);
 return left.every((file,index)=>file.path===right[index]?.path&&file.size===right[index]?.size&&file.sha256===right[index]?.sha256);
}
function emptyFiles():Record<FileComponent,FileRec[]>{
 return {vault:[],context:[],ui_state:[],plan_receipts:[]};
}
/** Canonical digest of a manifest body. A `digest` field on the input is ignored.
 * `scripts/backup-lab.mjs` does not record this value. The verifier requires it
 * from outside the manifest, as `expectedManifestDigest`. */
export function backupManifestDigest(manifest:Plain){
 const body:Plain={};
 for(const key of Object.keys(manifest))if(key!=='digest')body[key]=manifest[key];
 return digest(body);
}
function serializedLength(value:Plain){
 try{
  const text=JSON.stringify(value);
  return typeof text==='string'?Buffer.byteLength(text,'utf8'):null;
 }catch{return null;}
}
function parseFile(value:unknown):FileRec|null{
 if(!isPlain(value))return null;
 const keys=Object.keys(value);
 if(keys.length!==FILE_KEYS.length||!FILE_KEYS.every(key=>Object.prototype.hasOwnProperty.call(value,key)))return null;
 const size=integer(value.size);
 if(!safePath(value.path)||size===null||size<0||size>BYTE_LIMIT||typeof value.sha256!=='string'||!HEX.test(value.sha256))return null;
 return {path:value.path,size,sha256:value.sha256};
}
function manifestProof(value:unknown){
 return typeof value==='string'&&HEX.test(value)?value:null;
}
function parseManifest(value:unknown,truncatedFlag:boolean,expectedDigest:string):ParsedManifest{
 if(truncatedFlag||(isPlain(value)&&value.truncated===true))return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
 if(value===null||value===undefined)return {ok:false,reason:'manifesto_ausente',posteriorAfter:null};
 if(!isPlain(value))return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
 const size=serializedLength(value);
 if(size===null||size>RESTORE_MANIFEST_BYTE_LIMIT)return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
 const keys=Object.keys(value);
 const allowed=new Set<string>([...REQUIRED_KEYS,...OPTIONAL_KEYS]);
 if(!REQUIRED_KEYS.every(key=>Object.prototype.hasOwnProperty.call(value,key))||keys.some(key=>!allowed.has(key)))return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
 const schemaVersion=integer(value.schemaVersion);
 const createdAt=parseInstant(value.createdAt);
 const cutoff=Object.prototype.hasOwnProperty.call(value,'cutoff')?parseInstant(value.cutoff):undefined;
 if(schemaVersion===null||schemaVersion<1||value.scope!==RESTORE_MANIFEST_SCOPE||typeof value.backupId!=='string'||value.backupId.length<1||value.backupId.length>128
   ||typeof value.root!=='string'||value.root.length<1||value.root.length>TEXT_LIMIT||createdAt===null||typeof value.commit!=='string'||!COMMIT.test(value.commit)
   ||typeof value.databaseSha256!=='string'||!HEX.test(value.databaseSha256)||typeof value.limitation!=='string'||value.limitation.length>TEXT_LIMIT
   ||!Array.isArray(value.sources)||value.sources.length>LIST_LIMIT||!Array.isArray(value.missingOptional)||value.missingOptional.length>LIST_LIMIT
   ||!Array.isArray(value.files)||value.files.length>FILE_LIMIT||(cutoff===null))return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
 if(!value.sources.every(safePath)||!value.missingOptional.every(safePath))return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
 const sources=value.sources.filter(safePath);
 const missing=value.missingOptional.filter(safePath);
 const sourceSet=new Set(sources);
 const missingSet=new Set(missing);
 if(sourceSet.size!==sources.length||missingSet.size!==missing.length)return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
 for(const source of sources)if(missingSet.has(source))return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
 const files=emptyFiles();
 const seen=new Set<string>();
 let total=0;
 for(const entry of value.files){
  const file=parseFile(entry);
  const component=file?componentForPath(file.path):null;
  if(!file||!component||seen.has(file.path)||!sources.some(source=>coveredBySource(file.path,source)))return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
  if(missingSet.has('.state/keys')&&component==='vault')return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
  seen.add(file.path);
  total+=file.size;
  if(!Number.isSafeInteger(total)||total>BYTE_LIMIT)return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};
  files[component].push(file);
 }
 let computed:string;
 try{computed=backupManifestDigest(value);}catch{return {ok:false,reason:'manifesto_truncado',posteriorAfter:null};}
 if(computed!==expectedDigest)return {ok:false,reason:'digest_divergente',posteriorAfter:null};
 if(Object.prototype.hasOwnProperty.call(value,'digest')){
  if(typeof value.digest!=='string'||!HEX.test(value.digest)||value.digest!==computed)return {ok:false,reason:'digest_divergente',posteriorAfter:null};
 }
 if(cutoff!==undefined&&cutoff>createdAt)return {ok:false,reason:'corte_posterior_ao_backup',posteriorAfter:createdAt};
 if(schemaVersion!==SUPPORTED_SCHEMA_VERSION)return {ok:false,reason:'versao_incompativel',posteriorAfter:null};
 return {ok:true,posteriorAfter:cutoff??createdAt,databaseDigest:value.databaseSha256,files};
}
function effectKind(value:unknown):ExternalEffectKind|null{
 return typeof value==='string'&&(EXTERNAL_EFFECT_KINDS as readonly string[]).includes(value)?value as ExternalEffectKind:null;
}
/** Manifest `schemaVersion` is the manifest format. An observed envelope version
 * does not prove a component. A missing component version is not compatible. */
function provenComponentVersion(local:VersionState,schema:VersionState):VersionState{
 if(schema==='bad'||local!=='ok')return 'bad';
 return 'ok';
}
function parseObserved(value:unknown):Observed{
 const blank:Observed={present:false,schema:'missing',database:null,versions:{vault:'missing',context:'missing',ui_state:'missing',plan_receipts:'missing'},files:null};
 if(value===null||value===undefined)return blank;
 if(!isPlain(value))return {...blank,present:true,files:'invalid',schema:'bad',database:{digest:'',version:'bad'}};
 const schema=versionState(value.schemaVersion);
 const versions={vault:'missing',context:'missing',ui_state:'missing',plan_receipts:'missing'} as Record<FileComponent,VersionState>;
 if(value.versions!==undefined){
  if(!isPlain(value.versions))return {...blank,present:true,schema,files:'invalid'};
  for(const id of FILE_COMPONENTS)versions[id]=versionState(value.versions[id]);
 }
 let database:Observed['database']=null;
 if(value.database!==undefined&&value.database!==null){
  if(!isPlain(value.database)||typeof value.database.digest!=='string'||!HEX.test(value.database.digest))database={digest:'',version:provenComponentVersion(versionState(isPlain(value.database)?value.database.version:undefined),schema)};
  else database={digest:value.database.digest,version:provenComponentVersion(versionState(value.database.version),schema)};
 }
 let files:ObservedFiles=null;
 if(value.files!==undefined&&value.files!==null){
  if(!Array.isArray(value.files)||value.files.length>FILE_LIMIT)files='invalid';
  else{
   const parsed:FileRec[]=[];
   const seen=new Set<string>();
   for(const entry of value.files){
    const file=parseFile(entry);
    if(!file||seen.has(file.path)||!componentForPath(file.path)){files='invalid';break;}
    seen.add(file.path);
    parsed.push(file);
   }
   if(files!=='invalid')files=parsed;
  }
 }
 return {present:true,schema,database,versions,files};
}
function classifyDatabase(expected:string,observed:Observed):ComponentVerification{
 const id:RestoreComponentId='database';
 if(!observed.present||observed.database===null)return {id,verdict:'parcial',reason:'componente_ausente'};
 if(observed.database.version!=='ok')return {id,verdict:'inapto',reason:'versao_incompativel'};
 if(observed.database.digest!==expected)return {id,verdict:'inapto',reason:'digest_divergente'};
 return {id,verdict:'apto',reason:'componente_conferido'};
}
function classifyFiles(id:FileComponent,expected:readonly FileRec[],observed:Observed):ComponentVerification{
 if(expected.length===0)return {id,verdict:'parcial',reason:'componente_ausente'};
 if(!observed.present||observed.files===null)return {id,verdict:'parcial',reason:'componente_ausente'};
 if(observed.files==='invalid')return {id,verdict:'inapto',reason:'digest_divergente'};
 const actual=observed.files.filter(file=>componentForPath(file.path)===id);
 if(actual.length===0)return {id,verdict:'parcial',reason:'componente_ausente'};
 if(provenComponentVersion(observed.versions[id],observed.schema)!=='ok')return {id,verdict:'inapto',reason:'versao_incompativel'};
 if(!sameFiles(expected,actual))return {id,verdict:'inapto',reason:'digest_divergente'};
 return {id,verdict:'apto',reason:'componente_conferido'};
}
function parseEffects(value:unknown):{inventory:'ausente'}|{inventory:'invalido'}|{inventory:'fechado';effects:EffectDraft[]}{
 if(value===null||value===undefined)return {inventory:'ausente'};
 if(!Array.isArray(value)||value.length>RESTORE_EXTERNAL_EFFECT_LIMIT)return {inventory:'invalido'};
 const effects:EffectDraft[]=[];
 const seen=new Set<string>();
 for(const entry of value){
  if(!isPlain(entry))return {inventory:'invalido'};
  const kind=effectKind(entry.kind);
  const id=entry.id;
  const createdAt=entry.createdAt;
  if(!kind||typeof id!=='string'||!UUID.test(id)||seen.has(id)||typeof createdAt!=='string')return {inventory:'invalido'};
  seen.add(id);
  effects.push({kind,id,createdAt,at:parseInstant(createdAt)});
 }
 effects.sort((a,b)=>EFFECT_KIND_ORDER.get(a.kind)!-EFFECT_KIND_ORDER.get(b.kind)!||(a.createdAt<b.createdAt?-1:a.createdAt>b.createdAt?1:0)||(a.id<b.id?-1:a.id>b.id?1:0));
 return {inventory:'fechado',effects};
}
function classifyEffects(parsed:ReturnType<typeof parseEffects>,posteriorAfter:number|null):ExternalEffectReport{
 if(parsed.inventory==='ausente')return {inventory:'ausente',classification:'incerto',reconciliationRequired:true,safeToRepeat:false,reason:'inventario_externo_ausente',effects:[]};
 if(parsed.inventory==='invalido')return {inventory:'invalido',classification:'incerto',reconciliationRequired:true,safeToRepeat:false,reason:'inventario_externo_invalido',effects:[]};
 const effects:EffectVerification[]=parsed.effects.map(effect=>{
  if(posteriorAfter===null)return {kind:effect.kind,id:effect.id,classification:'incerto' as const,reconciliationRequired:true,safeToRepeat:false as const,reason:'efeito_externo_sem_corte' as const};
  if(effect.at===null)return {kind:effect.kind,id:effect.id,classification:'incerto' as const,reconciliationRequired:true,safeToRepeat:false as const,reason:'efeito_externo_tempo_invalido' as const};
  if(effect.at>posteriorAfter)return {kind:effect.kind,id:effect.id,classification:'incerto' as const,reconciliationRequired:true,safeToRepeat:false as const,reason:'efeito_externo_posterior' as const};
  return {kind:effect.kind,id:effect.id,classification:'incerto' as const,reconciliationRequired:true,safeToRepeat:false as const,reason:'efeito_externo_sem_corte' as const};
 });
 const uncertain=effects.some(effect=>effect.classification==='incerto');
 const reason:RestoreReason=effects.some(effect=>effect.reason==='efeito_externo_sem_corte')?'efeito_externo_sem_corte'
  :effects.some(effect=>effect.reason==='efeito_externo_posterior')?'efeito_externo_posterior'
  :effects.some(effect=>effect.reason==='efeito_externo_tempo_invalido')?'efeito_externo_tempo_invalido'
  :'inventario_externo_fechado';
 return {inventory:'fechado',classification:uncertain?'incerto':'nenhum_posterior',reconciliationRequired:uncertain,safeToRepeat:false,reason,effects};
}
function overall(components:ComponentVerification[],effects:ExternalEffectReport):{verdict:RestoreVerdict;reason:RestoreReason}{
 const unfit=components.find(component=>component.verdict==='inapto');
 if(unfit)return {verdict:'inapto',reason:unfit.reason};
 const partial=components.find(component=>component.verdict==='parcial');
 if(partial)return {verdict:'parcial',reason:partial.reason};
 if(effects.classification==='incerto')return {verdict:'parcial',reason:effects.reason};
 return {verdict:'apto',reason:'componente_conferido'};
}
function failedManifest(reason:ManifestFailure,effects:ExternalEffectReport):RestoreVerification{
 const verdict:RestoreVerdict='inapto';
 return {schemaVersion:1,kind:'restore_verification',verifierVersion:RESTORE_VERIFIER_VERSION,verdict,reason,
  components:RESTORE_COMPONENTS.map(id=>({id,verdict,reason})),externalEffects:effects,
  performedRestore:false,authorizesAdmission:false,authorizesRepeat:false};
}

/** Classify one in-memory restore description against a backup-lab manifest.
 * The same input yields the same report. `expectedManifestDigest` is mandatory
 * and must be the canonical digest registered outside the manifest. Without it
 * the verdict is inapto. `externalEffects` omitted or null is an unknown
 * inventory and cannot be apto. An explicit empty array is a closed claim about
 * that description, not a host scan. */
export function verifyRestore(input:unknown):RestoreVerification{
 const source=isPlain(input)?input:{};
 const truncated=source.manifestTruncated===true;
 const drafts=parseEffects(isPlain(input)?source.externalEffects:undefined);
 const proof=manifestProof(source.expectedManifestDigest);
 if(proof===null)return failedManifest('integridade do manifesto não comprovada',classifyEffects(drafts,null));
 const parsed=parseManifest(source.manifest,truncated,proof);
 const effects=classifyEffects(drafts,parsed.posteriorAfter);
 if(!parsed.ok)return failedManifest(parsed.reason,effects);
 const observed=parseObserved(source.observed);
 const components:ComponentVerification[]=[
  classifyDatabase(parsed.databaseDigest,observed),
  ...FILE_COMPONENTS.map(id=>classifyFiles(id,parsed.files[id],observed)),
 ];
 const result=overall(components,effects);
 return {schemaVersion:1,kind:'restore_verification',verifierVersion:RESTORE_VERIFIER_VERSION,verdict:result.verdict,reason:result.reason,
  components,externalEffects:effects,performedRestore:false,authorizesAdmission:false,authorizesRepeat:false};
}
