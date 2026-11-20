import {isAbsolute} from 'node:path';
import {Id,Refusal} from './contracts.ts';
import type {Installation} from './installation.ts';
import {CANDIDATE_IMAGE_KINDS,closeRound,registerCandidateImage,registerRoundTemp,registerWorkerWorktree,runPersonalArtifactRetention,type CandidateImageKind,type RetentionDeps} from './personal-artifact-retention.ts';

/**
 * Owner commands of `npm run personal:maintenance` for the artifacts that the product does not create itself:
 * worktrees of supervised workers, candidate module images and round folders opened from outside (for example the
 * manager's `/tmp/ac-<rodada>`). Everything the product creates by itself (module snapshots, evidence folders) is recorded
 * by the producer in `personal-artifact-hooks.ts` and needs no command.
 *
 * Each command only records ownership or ends a round. Nothing is removed here except by `--retencao-artefatos --aplicar`,
 * and that command removes only what the registry owns and what can be proved finished (see `personal-artifact-retention.ts`).
 *
 * Wiring in `personal-maintenance.ts` (argv = [installation, ...rest]):
 *   parse:  `if(isArtifactCommand(argv.slice(1)))return {installationPath,artifactArgs:argv.slice(1)};`
 *   run:    `if(parsed.artifactArgs)return runArtifactCommand(config,parsed.artifactArgs);`   (after the personal check)
 *   CLI:    merge `artifactCliMessages` into the message table and append `ARTIFACT_USAGE` to MAINTENANCE_USAGE.
 */

export const ARTIFACT_COMMANDS=['--registrar-worktree','--registrar-imagem','--registrar-temporario','--encerrar-rodada','--retencao-artefatos'] as const;
type ArtifactCommand=(typeof ARTIFACT_COMMANDS)[number];

export const ARTIFACT_USAGE=[
 '--registrar-worktree --projeto <id> --caminho <dir> --ramo <ramo> --base <ramo> [--adotar]',
 '--registrar-imagem --projeto <id> --modulo <modulo|native-runtime> --imagem <sha256:id>',
 '--registrar-temporario --projeto <id> --rodada <rodada> --caminho </tmp/ac-...>',
 '--encerrar-rodada --projeto <id> --rodada <rodada>',
 '--retencao-artefatos [--aplicar]',
].join(' | ');

export const artifactCliMessages:Record<string,string>={
 RETENTION_PROJECT_UNKNOWN:'O projeto informado não pertence a esta instalação.',
 RETENTION_REGISTRATION_INVALID:'O artefato não pôde ser comprovado: confira caminho, ramo, base, imagem local e a pasta temporária (/tmp/ac-..., sem link simbólico, do mesmo usuário).',
 RETENTION_REGISTRATION_CONFLICT:'Este artefato já está registrado com outros dados. Nada foi alterado.',
 RETENTION_REGISTRY_INVALID:'O registro privado de artefatos está ilegível ou foi alterado. Nada foi removido.',
 RETENTION_REGISTRY_BUSY:'O registro de artefatos está ocupado por outro processo. Repita em instantes.',
};

export function isArtifactCommand(args:readonly string[]):boolean{
 return (ARTIFACT_COMMANDS as readonly string[]).includes(args[0] as string);
}

const usage=()=>new Refusal('MAINTENANCE_USAGE');
const token=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const imageId=/^sha256:[a-f0-9]{64}$/;

/** Reads `--flag value` pairs and bare boolean flags. Repeated, unknown or missing flags are a usage error. */
function flags(args:readonly string[],values:readonly string[],booleans:readonly string[]){
 const out=new Map<string,string|true>();
 for(let i=0;i<args.length;i++){
  const flag=args[i]!;
  if(out.has(flag))throw usage();
  if(booleans.includes(flag)){out.set(flag,true);continue;}
  const value=args[++i];
  if(!values.includes(flag)||value===undefined||value.startsWith('--')||value.includes('\0'))throw usage();
  out.set(flag,value);
 }
 return out;
}
function required(found:Map<string,string|true>,names:readonly string[]){
 for(const name of names)if(typeof found.get(name)!=='string')throw usage();
 return (name:string)=>found.get(name) as string;
}
const project=(value:string)=>{if(!Id.safeParse(value).success)throw usage();return value;};
const path=(value:string)=>{if(!isAbsolute(value))throw usage();return value;};
const ref=(value:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value))throw usage();return value;};
const round=(value:string)=>{if(!token.test(value))throw usage();return value;};

/** Runs one artifact command. `args[0]` is the command; `isArtifactCommand` says whether it is one of ours.
 * Arguments are validated before anything is read or written. `deps` exists for tests. */
export async function runArtifactCommand(config:Installation,args:readonly string[],deps:RetentionDeps={}):Promise<string[]>{
 const command=args[0] as ArtifactCommand|undefined;
 if(!command||!isArtifactCommand(args))throw usage();
 const rest=args.slice(1);
 let run:()=>Promise<string[]>;
 switch(command){
  case '--registrar-worktree':{
   const get=required(flags(rest,['--projeto','--caminho','--ramo','--base'],['--adotar']),['--projeto','--caminho','--ramo','--base']);
   const adopt=rest.includes('--adotar');
   const input={projectId:project(get('--projeto')),path:path(get('--caminho')),branch:ref(get('--ramo')),base:ref(get('--base')),adopt};
   run=async()=>[`Worktree ${input.path} registrado (${adopt?'existente adotado':'novo'}; ramo ${input.branch}, integração em ${input.base}). Registro: ${await registerWorkerWorktree(config,input,deps)}.`];
   break;
  }
  case '--registrar-imagem':{
   const get=required(flags(rest,['--projeto','--modulo','--imagem'],[]),['--projeto','--modulo','--imagem']);
   const module=get('--modulo') as CandidateImageKind;
   if(!(CANDIDATE_IMAGE_KINDS as readonly string[]).includes(module)||!imageId.test(get('--imagem')))throw usage();
   const input={projectId:project(get('--projeto')),module,imageId:get('--imagem')};
   run=async()=>[`Imagem candidata ${input.imageId.slice(0,19)} (${module}) registrada. Registro: ${await registerCandidateImage(config,input,deps)}.`];
   break;
  }
  case '--registrar-temporario':{
   const get=required(flags(rest,['--projeto','--rodada','--caminho'],[]),['--projeto','--rodada','--caminho']);
   const input={projectId:project(get('--projeto')),roundId:round(get('--rodada')),path:path(get('--caminho'))};
   run=async()=>[`Temporário ${input.path} registrado na rodada ${input.roundId}. Registro: ${await registerRoundTemp(config,input,deps)}.`];
   break;
  }
  case '--encerrar-rodada':{
   const get=required(flags(rest,['--projeto','--rodada'],[]),['--projeto','--rodada']);
   const input={projectId:project(get('--projeto')),roundId:round(get('--rodada'))};
   run=async()=>{
    const endedAt=await closeRound(config,input,deps);
    return [`Rodada ${input.roundId} encerrada em ${new Date(endedAt).toISOString()}. Os temporários dela só ficam elegíveis 24 h depois.`];
   };
   break;
  }
  case '--retencao-artefatos':{
   const found=flags(rest,[],['--aplicar']);
   run=()=>runPersonalArtifactRetention(config,found.has('--aplicar'),deps);
   break;
  }
 }
 if(config.activation!=='personal')throw new Refusal('MAINTENANCE_PERSONAL_REQUIRED');
 return run();
}
