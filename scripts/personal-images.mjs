// Rebuilds the three personal native images and runs personal:setup.
// Usage: npm run personal:images -- <instalação.json> [nome]
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {basename,dirname,resolve,sep} from 'node:path';
import {rmSync} from 'node:fs';
const [installation,given]=process.argv.slice(2);
if(!installation){console.log('Uso: npm run personal:images -- <instalação.json> [nome]');process.exit(0);}
const file=resolve(installation);
const name=(given??basename(dirname(file))).replace(/[^A-Za-z0-9_-]/g,'-');
if(!name)throw Error('INVALID_SERVICE_NAME');
const env={...process.env};
const resolved=(bin)=>execFileSync('readlink',['-f',execFileSync('which',[bin],{encoding:'utf8'}).trim()],{encoding:'utf8'}).trim();
if(!env.AC_NATIVE_CLAUDE_BIN)env.AC_NATIVE_CLAUDE_BIN=resolved('claude');
if(!env.AC_NATIVE_GROK_BIN)env.AC_NATIVE_GROK_BIN=resolved('grok');
const npmRoot=execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim();
const elf=execFileSync('find',[npmRoot+'/@openai','-type','f','-name','codex','-size','+1M'],{encoding:'utf8'}).split('\n').map(line=>line.trim()).find(Boolean);
if(!elf)throw Error('CODEX_ELF_NOT_FOUND');
const sha=createHash('sha256').update(await readFile(elf)).digest('hex');
const prepare=(script)=>{
 const result=spawnSync(process.execPath,[resolve(import.meta.dirname,script),elf,sha],{env,encoding:'utf8',stdio:['inherit','pipe','inherit']});
 if(result.error||result.status)process.exit(result.status??1);
 const line=result.stdout.trim().split('\n').findLast(row=>row.startsWith('{'));
 if(!line)throw Error('PREPARE_OUTPUT_MISSING');
 const parsed=JSON.parse(line);if(!parsed.context||parsed.prepared!==true)throw Error('PREPARE_CONTEXT_MISSING');
 return parsed.context;
};
const planning=prepare('prepare-native-planning-image.mjs');
const execution=prepare('prepare-native-execution-image.mjs');
const tools=prepare('prepare-native-tools-image.mjs');
// Each build context holds copies of the CLI binaries (hundreds of MB). Remove it after the build, and prune the
// dangling image the previous build left behind, or repeated rebuilds fill the disk.
const stateRoot=resolve(import.meta.dirname,'..','.state');
const discard=context=>{const path=resolve(context);if(path.startsWith(stateRoot+sep)&&/^native-(planning|execution|tools)-image-[A-Za-z0-9]+$/.test(basename(path)))rmSync(path,{recursive:true,force:true});};
const build=(tag,context)=>{const result=spawnSync('docker',['build','-t',tag,context],{stdio:'inherit'});discard(context);if(result.error||result.status)process.exit(result.status??1);};
build('ac-native-planning:personal',planning);
build('ac-native-execution:personal',execution);
build('ac-native-tools:personal',tools);
const id=tag=>execFileSync('docker',['image','inspect',tag,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
const setup=spawnSync(process.execPath,[resolve(import.meta.dirname,'personal-setup.mjs'),file],{stdio:'inherit',env:{...env,
 AC_NATIVE_PLANNING_IMAGE:id('ac-native-planning:personal'),AC_NATIVE_WORKER_IMAGE:id('ac-native-execution:personal'),AC_NATIVE_TOOLS_IMAGE:id('ac-native-tools:personal')}});
if(setup.error||setup.status)process.exit(setup.status??1);
spawnSync('docker',['image','prune','-f'],{stdio:'ignore'});spawnSync('docker',['builder','prune','-f','--filter','until=1h'],{stdio:'ignore'});
console.log(`Reinicie o gateway: systemctl --user restart agent-control-gateway-${name}`);
