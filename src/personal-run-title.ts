/** One week. A finished run older than this leaves the active list in the view only. */
export const ACTIVE_VIEW_MAX_AGE_MS=7*24*60*60*1000;
const CONCLUDED=new Set(['done','cancelled','canceled']);

export type PlanTaskSummary={id:string;title?:unknown;summary?:unknown;name?:unknown;writePaths?:unknown};

export function clipPanelTitle(text:string):string{
 const line=text.trim().split('\n')[0]!.trim();
 return line.length>90?line.slice(0,90).trimEnd()+'…':line;
}

/** The plan task id inside an internal child-run title, when the whole title is that name. */
export function childRunTaskId(title:string):string|undefined{
 return /^(?:AC_MANAGED_UNIT:)?task-([a-z][a-z0-9_-]{0,47})$/.exec(title.trim())?.[1];
}

/** The plan's own title for a child run, or the task summary the proposal already shows. */
export function planTaskDisplayTitle(title:string,tasks:readonly PlanTaskSummary[]):string|undefined{
 const id=childRunTaskId(title);
 if(!id)return;
 const task=tasks.find(item=>item.id===id);
 if(!task)return;
 for(const key of ['title','summary','name'] as const){
  const value=task[key];
  if(typeof value==='string'&&value.trim())return clipPanelTitle(value);
 }
 const paths=Array.isArray(task.writePaths)?task.writePaths.filter((item):item is string=>typeof item==='string'&&item.trim().length>0):[];
 return clipPanelTitle(paths.length?`${task.id}: ${paths.join(', ')}`:task.id);
}

/** Finished runs older than seven days read as archived. The stored record is not changed. */
export function archivedInView<T extends object>(run:T,now:number):T & {archived?:boolean}{
 const view=run as T & {status?:unknown;archived?:unknown;finishedAt?:unknown;updatedAt?:unknown};
 if(view.archived===true)return run;
 if(typeof view.status!=='string'||!CONCLUDED.has(view.status))return run;
 const stamp=typeof view.finishedAt==='string'?view.finishedAt:typeof view.updatedAt==='string'?view.updatedAt:'';
 const at=Date.parse(stamp);
 if(!Number.isFinite(at)||now-at<=ACTIVE_VIEW_MAX_AGE_MS)return run;
 return {...run,archived:true};
}
