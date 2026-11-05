/** Monotonic durations only: no principal, token, provider or request payload. */
export function serverTiming(started:number,authenticationMs:number,now=performance.now()):string{
 const total=Math.max(0,now-started),auth=Math.max(0,Math.min(authenticationMs,total));
 return `authentication;dur=${auth.toFixed(3)}, application;dur=${Math.max(0,total-auth).toFixed(3)}, total;dur=${total.toFixed(3)}`;
}
