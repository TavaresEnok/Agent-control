/** True when text is one JSON object, which is what every evaluator verdict must be. */
export function isJsonObject(text:string){try{const v=JSON.parse(text);return Boolean(v)&&typeof v==='object'&&!Array.isArray(v);}catch{return false;}}

/** Runs an evaluator once more when its verdict is not readable JSON. Programmers and failures are not retried. */
export async function runWithVerdictRetry<T extends {output:string}>(evaluator:boolean,aborted:()=>boolean,runOnce:()=>Promise<{result:T;failure:string|null}>){
 for(let attempt=0;;attempt++){
  const ran=await runOnce();
  if(!evaluator||ran.failure||attempt>=1||aborted()||isJsonObject(ran.result.output))return ran;
 }
}
