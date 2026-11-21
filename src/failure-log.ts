/** Failures a caller deliberately does not propagate still leave one line on stderr.
 * Only a short code leaves: never the message, which may carry paths, tokens or owner text. */

/** Short, content-free label: the product refusal or database error code, otherwise the error name. */
export function failureCode(error:unknown):string{
 const code=(error as {code?:unknown}|null)?.code;
 const raw=typeof code==='string'&&code?code:error instanceof Error?error.name:'UNKNOWN';
 return raw.replace(/[^\w.-]/g,'').slice(0,64)||'UNKNOWN';
}

/** Logs a contained failure as {"event":EVENT,"code":CODE}. Never throws. */
export function logContainedFailure(event:string,error?:unknown):void{
 try{console.error(JSON.stringify(error===undefined?{event}:{event,code:failureCode(error)}));}
 catch{/* stderr itself failed: nothing else can report it */}
}

/** A .catch handler that logs and resolves to the given fallback. */
export function containFailure<T>(event:string,fallback:T):(error:unknown)=>T{
 return error=>{logContainedFailure(event,error);return fallback;};
}
