function jsonError(error:string,status:number,noStore:boolean){
 return Response.json({error},{status,headers:noStore?{'cache-control':'no-store'}:undefined});
}
/**
 * Shared JSON reader. The limit is chosen by the exact route.
 * A declared Content-Length above the limit is refused, and the stream is still counted
 * when the header is absent or smaller than the bytes that arrive. The reader is cancelled
 * on overflow, deadline and caller abort.
 */
export async function readJsonBody(request:Request,limit:number,timeoutMs:number,noStore:boolean):Promise<unknown|Response>{
 if(request.signal.aborted)return jsonError('REQUEST_ABORTED',400,noStore);
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))return jsonError('UNSUPPORTED_MEDIA_TYPE',415,noStore);
 if(!/^(?:identity)?$/i.test(request.headers.get('content-encoding')??''))return jsonError('UNSUPPORTED_CONTENT_ENCODING',415,noStore);
 if(Number(request.headers.get('content-length')??0)>limit)return jsonError('REQUEST_BODY_TOO_LARGE',413,noStore);
 const reader=request.body?.getReader();let total=0;const chunks:Uint8Array[]=[];
 if(reader){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=Symbol('body deadline'),aborted=Symbol('body aborted');
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(deadline),timeoutMs);});
  let onAbort=()=>{};
  const cancellation=new Promise<never>((_,reject)=>{
   onAbort=()=>reject(aborted);
   if(request.signal.aborted)reject(aborted);
   else request.signal.addEventListener('abort',onAbort,{once:true});
  });
  void cancellation.catch(()=>{/* marks the rejection handled; raced below */});
  try{
   for(;;){
    if(request.signal.aborted){void reader.cancel().catch(()=>{/* best-effort cancel of a stream that is abandoned anyway */});return jsonError('REQUEST_ABORTED',400,noStore);}
    const part=await Promise.race([reader.read(),timeout,cancellation]);
    if(part.done)break;
    total+=part.value.byteLength;
    if(total>limit){void reader.cancel().catch(()=>{/* best-effort cancel of a stream that is abandoned anyway */});return jsonError('REQUEST_BODY_TOO_LARGE',413,noStore);}
    chunks.push(part.value);
   }
  }catch(error){
   void reader.cancel().catch(()=>{/* best-effort cancel of a stream that is abandoned anyway */});
   if(error===deadline)return jsonError('REQUEST_BODY_TIMEOUT',408,noStore);
   if(error===aborted)return jsonError('REQUEST_ABORTED',400,noStore);
   throw error;
  }finally{clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);}
 }
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder().decode(bytes));
}

