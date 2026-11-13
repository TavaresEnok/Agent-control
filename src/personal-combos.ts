import {randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {Capacity,CapacityPolicy,type Role} from './capacity.ts';
import {Id,Refusal} from './contracts.ts';
import {Effort} from './effort.ts';
import type {Ledger} from './ledger.ts';

const Provider=z.enum(['claude','grok','codex']);
const ComboReserve=z.object({provider:Provider,model:z.string().min(1).max(100),effort:Effort}).strict();
export type ComboReserve=z.infer<typeof ComboReserve>;
export const ComboSlot=z.object({
 provider:Provider,model:z.string().min(1).max(100),effort:Effort,count:z.number().int().min(1).max(10).default(1),
 reserve:ComboReserve.optional(),
}).strict();
export type ComboSlot=z.infer<typeof ComboSlot>;
const ProgrammerSlots=z.array(ComboSlot).min(1).max(4);
export const PersonalCombo=z.object({
 name:z.string().trim().min(1).max(80),
 roles:z.object({
  manager:ComboSlot,reviewer:ComboSlot,qa:ComboSlot.optional(),
  programmer:z.object({standard:ProgrammerSlots,basic:z.array(ComboSlot).max(4).optional()}).strict(),
 }).strict(),
}).strict();
export type PersonalCombo=z.infer<typeof PersonalCombo>;
const ComboFile=z.object({schemaVersion:z.literal(1),combos:z.array(PersonalCombo).max(40)}).strict();

const slot=(provider:ComboSlot['provider'],model:string,effort:ComboSlot['effort'],count=1,reserve?:ComboReserve):ComboSlot=>
 ({provider,model,effort,count,...(reserve?{reserve}:{})});

/** The four teams the owner asked for. Counts are explicit so the JSON stays stable. */
export const builtinCombos:PersonalCombo[]=[
 {name:'padrão',roles:{manager:slot('claude','claude-sonnet-5-5','medium'),reviewer:slot('claude','claude-sonnet-5-5','medium'),programmer:{standard:[slot('grok','grok-4.7','medium',2)]}}},
 {name:'superfoda',roles:{manager:slot('claude','claude-opus-5-5','high'),reviewer:slot('claude','claude-opus-5-5','high'),programmer:{standard:[slot('codex','gpt-6.1-sol','medium',3)]},qa:slot('grok','grok-4.7','high')}},
 {name:'megapoderoso',roles:{manager:slot('claude','claude-opus-5-5','xhigh'),reviewer:slot('claude','claude-opus-5-5','high'),programmer:{standard:[slot('codex','gpt-6.1-sol','high',4)],basic:[slot('grok','grok-4.7','high',2)]},qa:slot('claude','claude-opus-5-5','medium')}},
 {name:'econômico',roles:{manager:slot('claude','claude-sonnet-5-5','low'),reviewer:slot('claude','claude-sonnet-5-5','low'),programmer:{standard:[slot('grok','grok-4.7','low',1)]}}},
].map(combo=>PersonalCombo.parse(combo));

const catalogRoles=['manager','programmer','reviewer','qa','specialist','judge'] as const;

export function combosPath(dataDirectory:string){
 if(!dataDirectory||resolve(dataDirectory)!==dataDirectory)throw new Refusal('COMBOS_DIRECTORY_INVALID');
 return join(dataDirectory,'combos.json');
}

export async function readOwnerCombos(dataDirectory:string):Promise<PersonalCombo[]>{
 let text:string;
 try{text=await readFile(combosPath(dataDirectory),'utf8');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
 try{return ComboFile.parse(JSON.parse(text)).combos;}
 catch{throw new Refusal('COMBOS_FILE_INVALID');}
}

/** Inserts or replaces one owner combo. The file is mode 600. A custom name hides the built-in of the same name. */
export async function writeOwnerCombo(dataDirectory:string,raw:PersonalCombo){
 const combo=PersonalCombo.parse(raw);
 const current=await readOwnerCombos(dataDirectory);
 const index=current.findIndex(item=>item.name===combo.name);
 if(index>=0)current[index]=combo;else current.push(combo);
 if(current.length>40)throw new Refusal('COMBO_LIMIT');
 const path=combosPath(dataDirectory),temporary=path+'.tmp';
 await mkdir(dataDirectory,{recursive:true,mode:0o700});
 const body=JSON.stringify({schemaVersion:1,combos:current})+'\n';
 await writeFile(temporary,body,{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path);await chmod(path,0o600);
 return combo;
}

export async function listPersonalCombos(dataDirectory:string){
 const custom=await readOwnerCombos(dataDirectory);
 const hidden=new Set(custom.map(combo=>combo.name));
 return {current:null as string|null,combos:[...custom,...builtinCombos.filter(combo=>!hidden.has(combo.name))]};
}

/** Name stored on the project's assigned capacity policy. Null when no combo was applied. */
export async function projectComboName(db:{query:(text:string,values?:unknown[])=>Promise<{rows:Array<Record<string,unknown>>}>},projectId:string){
 const row=(await db.query(`SELECT r.snapshot->>'combo' AS combo FROM ac_contexts x JOIN ac_policy_revisions r ON r.project_id=x.project_id AND r.revision=x.capacity_policy_revision WHERE x.project_id=$1 AND NOT x.archived AND jsonb_typeof(r.snapshot->'combo')='string' ORDER BY x.id LIMIT 1`,[projectId])).rows[0];
 const name=row?.combo;
 return typeof name==='string'&&name.length>0?name:null;
}

/** Custom combos win on an exact name. Otherwise one case-insensitive match, custom first. */
export function findPersonalCombo(name:string,custom:readonly PersonalCombo[]):PersonalCombo{
 const wanted=name.trim();
 const exact=custom.find(combo=>combo.name===wanted)??builtinCombos.find(combo=>combo.name===wanted);
 if(exact)return exact;
 const fold=(value:string)=>value.toLocaleLowerCase('pt-BR');
 const folded=fold(wanted);
 const customHits=custom.filter(combo=>fold(combo.name)===folded);
 if(customHits.length>1)throw new Refusal('COMBO_NAME_AMBIGUOUS');
 if(customHits.length===1)return customHits[0]!;
 const builtinHits=builtinCombos.filter(combo=>fold(combo.name)===folded);
 if(builtinHits.length===1)return builtinHits[0]!;
 throw new Refusal('COMBO_NOT_FOUND',404);
}

type SlotUse={role:Role;slot:ComboSlot};
function slotsOf(combo:PersonalCombo):SlotUse[]{
 const uses:SlotUse[]=[{role:'manager',slot:combo.roles.manager},{role:'reviewer',slot:combo.roles.reviewer}];
 if(combo.roles.qa)uses.push({role:'qa',slot:combo.roles.qa});
 for(const slot of combo.roles.programmer.standard)uses.push({role:'programmer',slot});
 for(const slot of combo.roles.programmer.basic??[])uses.push({role:'programmer',slot});
 return uses;
}
function reserveSpec(spec:ComboSlot):ComboSlot|null{
 if(!spec.reserve)return null;
 return {provider:spec.reserve.provider,model:spec.reserve.model,effort:spec.reserve.effort,count:1};
}
function modelsOf(spec:ComboSlot):Array<[string,string]>{
 const models:[[string,string]]=[[spec.provider,spec.model]];
 if(spec.reserve)models.push([spec.reserve.provider,spec.reserve.model]);
 return models;
}

export type AppliedCombo={
 name:string;revision:number;maxProgrammersPerContext:number;qaModel:boolean;
 manager:string[];reviewer:string[];programmerStandard:string[];programmerBasic:string[];qa:string[];
 combo:PersonalCombo;
};

function slotText(slot:ComboSlot){return `${slot.count} × ${slot.provider} · ${slot.model} · ${slot.effort}`;}
/** Portuguese summary shown after "use o combo". */
export function describeAppliedCombo(applied:AppliedCombo){
 const combo=applied.combo;
 const lines=[
  `Combo ${applied.name} em uso.`,
  `Gerente: ${slotText(combo.roles.manager)}`,
  `Revisor: ${slotText(combo.roles.reviewer)}`,
  `Programadores padrão: ${combo.roles.programmer.standard.map(slotText).join('; ')}`,
 ];
 if(combo.roles.programmer.basic?.length)lines.push(`Programadores básicos: ${combo.roles.programmer.basic.map(slotText).join('; ')}`);
 lines.push(combo.roles.qa?`QA: ${slotText(combo.roles.qa)}`:'QA: script automático do projeto (sem modelo)');
 lines.push(`Programadores por contexto: ${applied.maxProgrammersPerContext}`);
 return lines.join('\n');
}

const accountRequired=(provider:string)=>provider==='codex'?'CODEX_ACCOUNT_REQUIRED':provider==='claude'?'CLAUDE_ACCOUNT_REQUIRED':provider==='grok'?'GROK_ACCOUNT_REQUIRED':'PROVIDER_ACCOUNT_REQUIRED';

/**
 * Publishes one capacity revision for the combo, or changes nothing.
 * Profiles the combo does not use are disabled, never deleted. Disabling is global on the profile row.
 * A combo without model QA keeps the enabled QA profiles so script QA can still reserve.
 */
export async function applyPersonalCombo(ledger:Ledger,owner:string,projectId:string,name:string,dataDirectory:string):Promise<AppliedCombo>{
 Id.parse(projectId);
 const combo=findPersonalCombo(name,await readOwnerCombos(dataDirectory));
 const uses=slotsOf(combo);
 const programmerCount=uses.filter(use=>use.role==='programmer').reduce((sum,use)=>sum+use.slot.count,0);
 if(programmerCount>10)throw new Refusal('COMBO_TOO_MANY_PROGRAMMERS');
 return ledger.tx(async c=>{
  const capacity=new Capacity(ledger,c);
  await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE',[projectId]);
  const membership=await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[projectId,owner]);
  if(!membership.rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
  const accountRows=(await c.query(`SELECT a.id,a.provider FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id
   WHERE x.project_id=$1 AND a.owner_id=$2 AND a.enabled ORDER BY a.id`,[projectId,owner])).rows;
  const accounts=new Map<string,string>();
  for(const row of accountRows)if(!accounts.has(String(row.provider)))accounts.set(String(row.provider),String(row.id));
  for(const provider of ['claude','grok','codex'] as const)
   if(uses.some(use=>use.slot.provider===provider||use.slot.reserve?.provider===provider)&&!accounts.has(provider))throw new Refusal(accountRequired(provider));
  const seenModels=new Set<string>();
  for(const use of uses)for(const [provider,model] of modelsOf(use.slot)){
   const key=provider+'\0'+model;
   if(seenModels.has(key))continue;seenModels.add(key);
   const existing=await c.query('SELECT 1 FROM ac_model_catalog WHERE provider=$1 AND model=$2',[provider,model]);
   if(!existing.rowCount)await capacity.registerModel(owner,{provider,model,efforts:['low','medium','high'],roles:[...catalogRoles],source:'personal://account-add'});
  }
  const used=new Set<string>();
  const take=async(role:Role,spec:ComboSlot)=>{
   const accountId=accounts.get(spec.provider)!;
   const rows=(await c.query(`SELECT id,enabled,revision FROM ac_profiles
    WHERE account_id=$1 AND model=$2 AND effort=$3 AND role=$4 AND NOT (id=ANY($5::uuid[]))
    ORDER BY enabled DESC,id`,[accountId,spec.model,spec.effort,role,[...used]])).rows;
   const ids:string[]=[];
   for(const row of rows){
    if(ids.length>=spec.count)break;
    if(!row.enabled)await capacity.setEnabled(owner,projectId,'profile',{id:String(row.id),enabled:true,expectedRevision:Number(row.revision)});
    ids.push(String(row.id));used.add(String(row.id));
   }
   while(ids.length<spec.count){
    const id=randomUUID();
    await capacity.addProfile(owner,projectId,{id,accountId,model:spec.model,effort:spec.effort,role});
    ids.push(id);used.add(id);
   }
   return ids;
  };
  const takeReserve=async(role:Role,spec:ComboSlot)=>{const reserve=reserveSpec(spec);return reserve?take(role,reserve):[];};
  const manager=await take('manager',combo.roles.manager);
  const managerReserve=await takeReserve('manager',combo.roles.manager);
  const reviewer=await take('reviewer',combo.roles.reviewer);
  const reviewerReserve=await takeReserve('reviewer',combo.roles.reviewer);
  const programmerStandard:string[]=[];const standardReserve:string[]=[];
  for(const spec of combo.roles.programmer.standard){programmerStandard.push(...await take('programmer',spec));standardReserve.push(...await takeReserve('programmer',spec));}
  const programmerBasic:string[]=[];const basicReserve:string[]=[];
  for(const spec of combo.roles.programmer.basic??[]){programmerBasic.push(...await take('programmer',spec));basicReserve.push(...await takeReserve('programmer',spec));}
  const previous=(await c.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',[projectId])).rows[0];
  const prev=previous?CapacityPolicy.parse(previous.snapshot):null;
  let qa:string[]=[];let qaReserve:string[]=[];
  if(combo.roles.qa){qa=await take('qa',combo.roles.qa);qaReserve=await takeReserve('qa',combo.roles.qa);}
  else if(prev?.roles.qa){
   const still=(await c.query('SELECT id FROM ac_profiles WHERE id=ANY($1::uuid[]) AND enabled',[prev.roles.qa.regular])).rows.map(row=>String(row.id));
   const live=new Set(still);
   qa=prev.roles.qa.regular.filter(id=>live.has(id));
  }
  const keep=new Set([...manager,...managerReserve,...reviewer,...reviewerReserve,...programmerStandard,...standardReserve,...programmerBasic,...basicReserve,...qa,...qaReserve]);
  const sweep=['manager','reviewer','programmer',...(combo.roles.qa?['qa']:[])];
  const extras=(await c.query(`SELECT p.id,p.revision FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id
   WHERE x.project_id=$1 AND p.enabled AND p.role=ANY($2::text[])`,[projectId,sweep])).rows;
  for(const row of extras)if(!keep.has(String(row.id)))
   await capacity.setEnabled(owner,projectId,'profile',{id:String(row.id),enabled:false,expectedRevision:Number(row.revision)});
  const expected=Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_policy_revisions WHERE project_id=$1',[projectId])).rows[0].revision);
  const roles:CapacityPolicy['roles']={
   manager:{regular:manager,emergency:managerReserve},reviewer:{regular:reviewer,emergency:reviewerReserve},
   programmer:{regular:[...programmerStandard,...programmerBasic],emergency:[...standardReserve,...basicReserve]},
  };
  if(qa.length)roles.qa={regular:qa,emergency:qaReserve};
  if(prev?.roles.specialist)roles.specialist=prev.roles.specialist;
  if(prev?.roles.judge)roles.judge=prev.roles.judge;
  const programmerTiers:NonNullable<CapacityPolicy['programmerTiers']>={standard:programmerStandard,basic:programmerBasic};
  if(standardReserve.length)programmerTiers.standardReserve=standardReserve;
  if(basicReserve.length)programmerTiers.basicReserve=basicReserve;
  const policy=CapacityPolicy.parse({
   schemaVersion:1,maxProgrammersPerContext:programmerCount,maxEvaluatorsPerContext:prev?.maxEvaluatorsPerContext??2,roles,
   combo:combo.name,programmerTiers,qaModel:Boolean(combo.roles.qa),
  });
  const revision=await capacity.publish(owner,projectId,expected,policy);
  const contexts=(await c.query('SELECT id FROM ac_contexts WHERE project_id=$1 AND NOT archived ORDER BY id',[projectId])).rows;
  for(const row of contexts)await capacity.assignPolicy(owner,String(row.id),revision);
  return {name:combo.name,revision,maxProgrammersPerContext:programmerCount,qaModel:Boolean(combo.roles.qa),manager,reviewer,programmerStandard,programmerBasic,qa,combo};
 });
}
