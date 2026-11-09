/** Fixed-window ceiling for unauthenticated routes that call the upstream.
 * The relay has no trustworthy client address, so the window is per route. */
export function preauthLimiter(limit:number,windowMs:number,now:()=>number=Date.now){
 const windows=new Map<string,{start:number;count:number}>();
 return (route:string)=>{
  const time=now(),current=windows.get(route);
  if(!current||time-current.start>=windowMs){windows.set(route,{start:time,count:1});return true;}
  if(current.count>=limit)return false;
  current.count++;return true;
 };
}
