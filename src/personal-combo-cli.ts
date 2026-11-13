import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {loadInstallation,type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {applyPersonalCombo,describeAppliedCombo,listPersonalCombos,projectComboName,type PersonalCombo} from './personal-combos.ts';
import {personalComboRefusal} from './personal-conversation.ts';

const usage='Uso: npm run personal:combo -- <instalação.json> <projeto> list|apply <nome>';

function project(config:Installation,token:string){
 const hits=[config.project,...config.projects].filter(item=>item.id===token||item.label===token);
 if(hits.length!==1)throw new Refusal(hits.length?'COMBO_PROJECT_AMBIGUOUS':'COMBO_PROJECT_NOT_FOUND');
 return hits[0]!;
}

function slotText(slot:PersonalCombo['roles']['manager']){
 return `${slot.count} × ${slot.provider} · ${slot.model} · ${slot.effort}`;
}

/** One combo as shown by `list`. The current project combo is marked. */
export function formatListedCombo(combo:PersonalCombo,current:boolean){
 const lines=[
  current?`${combo.name} (em uso)`:combo.name,
  `Gerente: ${slotText(combo.roles.manager)}`,
  `Revisor: ${slotText(combo.roles.reviewer)}`,
  `Programadores padrão: ${combo.roles.programmer.standard.map(slotText).join('; ')}`,
 ];
 if(combo.roles.programmer.basic?.length)lines.push(`Programadores básicos: ${combo.roles.programmer.basic.map(slotText).join('; ')}`);
 lines.push(combo.roles.qa?`QA: ${slotText(combo.roles.qa)}`:'QA: script automático do projeto (sem modelo)');
 return lines.join('\n');
}

/** list prints the file plus the project's current combo. apply publishes that combo or changes nothing. */
export async function runPersonalComboCli(argv:string[]){
 const [file,token,action,name]=argv;
 const trimmed=name?.trim()??'';
 if(!file||!token||!action||file.startsWith('--')||token.startsWith('--')||!['list','apply'].includes(action))throw new Refusal('COMBO_USAGE');
 if(action==='list'&&argv.length!==3)throw new Refusal('COMBO_USAGE');
 if(action==='apply'&&(argv.length!==4||!trimmed||trimmed.length>80||trimmed.startsWith('--')))throw new Refusal('COMBO_USAGE');
 const config=await loadInstallation(file),selected=project(config,token);
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{
  if(action==='list'){
   const listed=await listPersonalCombos(config.dataDirectory);
   const current=await projectComboName(ledger.pool,selected.id);
   const lines=[`Combo atual: ${current??'nenhum'}`];
   for(const combo of listed.combos){lines.push('');lines.push(formatListedCombo(combo,combo.name===current));}
   return lines;
  }
  return [describeAppliedCombo(await applyPersonalCombo(ledger,selected.owner,selected.id,trimmed,config.dataDirectory))];
 }finally{await ledger.close();}
}

const messages:Record<string,string>={
 COMBO_USAGE:usage,
 COMBO_PROJECT_NOT_FOUND:'Projeto não encontrado. Use o label ou o id.',
 COMBO_PROJECT_AMBIGUOUS:'Há mais de um projeto com esse label.',
};
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runPersonalComboCli(process.argv.slice(2)).then(lines=>{for(const line of lines)console.log(line);},error=>{
  const code=error instanceof Refusal?error.code:error instanceof Error?error.message:'COMBO_FAILED';
  console.error(messages[code]??(error instanceof Refusal?personalComboRefusal(code):code));
  process.exit(1);
 });
}
