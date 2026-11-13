/** Ten minutes, measured by the database clock that stored the earlier notice. */
export const PERSONAL_NOTICE_WINDOW_MS=10*60*1000;

export type PersonalNoticeKind='manager-reply'|'proposal'|'team-report';
export type PersonalNoticeInput={
 text:string;
 localId?:string;
 /** A manager reply, a proposal or a team report is never suppressed. */
 kind?:PersonalNoticeKind;
 recent:readonly {text:string;ageMs:number}[];
 windowMs?:number;
};

/** A block warning or a queue line can be dropped when the same text was recorded recently.
 * Everything else, including a manager reply that happens to use the same words, stays. */
export function isRepeatablePersonalNotice(text:string,localId='',kind?:PersonalNoticeKind):boolean{
 if(kind==='manager-reply'||kind==='proposal'||kind==='team-report')return false;
 if(localId.startsWith('answer-')||localId.startsWith('proposal-')||localId.startsWith('team-'))return false;
 const trimmed=text.trim();
 if(trimmed.startsWith('Proposta de plano')||trimmed.startsWith('Equipe:'))return false;
 if(/^(Gerente|Programador|QA|Revisor|Juiz|Especialista)(?: \(|:| )/.test(trimmed))return false;
 return trimmed.startsWith('Atenção —')||trimmed.startsWith('Atenção -')||trimmed==='Tarefa na fila.';
}

/** True when this notice must not be written to the conversation or sent as a push. */
export function suppressRepeatedPersonalNotice(input:PersonalNoticeInput):boolean{
 if(!isRepeatablePersonalNotice(input.text,input.localId??'',input.kind))return false;
 const windowMs=input.windowMs??PERSONAL_NOTICE_WINDOW_MS;
 return input.recent.some(item=>item.text===input.text&&item.ageMs>=0&&item.ageMs<windowMs);
}

type NoticeQuery={query:(sql:string,params?:unknown[])=>Promise<{rows:{text?:unknown;age_ms?:unknown}[]}>};

/** Notices already stored for this context, with age from the database clock. */
export async function recentPersonalNotices(db:NoticeQuery,contextId:string):Promise<{text:string;ageMs:number}[]>{
 const rows=(await db.query(`SELECT text, (extract(epoch FROM (clock_timestamp()-created_at))*1000)::float8 AS age_ms
  FROM ac_personal_messages WHERE context_id=$1 AND role='manager' AND created_at>=clock_timestamp()-interval '10 minutes'`,[contextId])).rows;
 return rows.map(row=>({text:String(row.text??''),ageMs:Number(row.age_ms)}));
}
