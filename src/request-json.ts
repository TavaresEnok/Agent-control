function jsonError(error:string,status:number,noStore:boolean){
 return new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json',...(noStore?{'cache-control':'no-store'}:{})}});
}
/**
 * Shared JSON reader. The limit is chosen by the exact route.
 * A declared Content-Length above the limit is refused, and the stream is still counted
 * when the header is absent or smaller than the bytes that arrive. The reader is cancelled
 * on overflow, deadline and caller abort.
 */
export async function readJsonBody(request:Request,limit:number,timeoutMs:number,noStore:boolean):Promise<unknown|Response>{
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))return jsonError('UNSUPPORTED_MEDIA_TYPE',415,noStore);
 if(!/^(?:identity)?$/i.test(request.headers.get('content-encoding')??''))return jsonError('UNSUPPORTED_CONTENT_ENCODING',415,noStore);
 const body=await readRequestBody(request,limit,timeoutMs,noStore);
 return body instanceof Response?body:JSON.parse(body);
}

export async function readRequestBody(request:Request,limit:number,timeoutMs:number,noStore:boolean):Promise<string|Response>{
 if(request.signal.aborted)return jsonError('REQUEST_ABORTED',400,noStore);
 if(Number(request.headers.get('content-length')??0)>limit){
  void request.body?.cancel().catch(()=>{/* The declared size already caused a refusal. */});
  return jsonError('REQUEST_BODY_TOO_LARGE',413,noStore);
 }
 const reader=request.body?.getReader();let total=0;const chunks:Uint8Array[]=[];
 if(reader){
  let interrupted:Response|undefined;
  const cancel=(error:string,status:number)=>{
   interrupted??=jsonError(error,status,noStore);
   void reader.cancel().catch(()=>{/* The request already has its abort, timeout or size response. */});
  };
  const abort=()=>cancel('REQUEST_ABORTED',400);
  const timer=setTimeout(()=>cancel('REQUEST_BODY_TIMEOUT',408),timeoutMs);
  request.signal.addEventListener('abort',abort,{once:true});
  try{
   for(;;){
    const part=await reader.read();
    if(interrupted)return interrupted;
    if(part.done)break;
    total+=part.value.byteLength;
    if(total>limit){cancel('REQUEST_BODY_TOO_LARGE',413);return interrupted!;}
    chunks.push(part.value);
   }
  }catch(error){
   if(interrupted)return interrupted;
   void reader.cancel().catch(()=>{/* Keep the original read error. */});
   throw error;
  }finally{
   clearTimeout(timer);
   request.signal.removeEventListener('abort',abort);
   reader.releaseLock();
  }
 }
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return new TextDecoder().decode(bytes);
}
