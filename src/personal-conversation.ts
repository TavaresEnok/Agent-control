const CHANGE=/\b(adicione|adicionar|crie|criar|implemente|implementar|corrija|corrigir|remova|remover|atualize|atualizar|refatore|mude|altere|inclua|faça|faz|add|create|implement|fix|remove|update|refactor)\b/i;
export function classifyPersonalText(text:string):'answer'|'plan'{
 const trimmed=text.trim();
 if(CHANGE.test(trimmed))return 'plan';
 if(trimmed.endsWith('?')||/^(o que|qual|quais|quem|como|por que|porque|quando|onde|explique|resuma|what|why|how|when|where)\b/i.test(trimmed))return 'answer';
 return 'plan';
}
/** "use o combo <nome>" applies that team. The name may contain spaces. */
export function personalComboRequest(text:string):string|null{
 const match=/^use o combo\s+(\S.*)$/i.exec(text.trim());
 const name=match?.[1]?.trim()??'';
 return name.length>0&&name.length<=80?name:null;
}
export function personalComboRefusal(code:string){
 if(code==='CODEX_ACCOUNT_REQUIRED')return 'Falta uma conta Codex ativa. Nada foi alterado.';
 if(code==='CLAUDE_ACCOUNT_REQUIRED')return 'Falta uma conta Claude ativa. Nada foi alterado.';
 if(code==='GROK_ACCOUNT_REQUIRED')return 'Falta uma conta Grok ativa. Nada foi alterado.';
 if(code==='COMBO_NOT_FOUND')return 'Combo não encontrado. Nada foi alterado.';
 if(code==='COMBO_NAME_AMBIGUOUS')return 'Há mais de um combo com esse nome. Nada foi alterado.';
 if(code==='COMBO_TOO_MANY_PROGRAMMERS')return 'A soma dos programadores passa de 10. Nada foi alterado.';
 if(code==='COMBO_MINIMUM_REQUIRED')return 'Um combo precisa de pelo menos 3 programadores e de reserva no gerente, no revisor e nos programadores. Nada foi alterado.';
 if(code==='PROJECT_OWNER_REQUIRED')return 'Só o dono da instalação pode aplicar um combo. Nada foi alterado.';
 return 'Não foi possível aplicar o combo. Nada foi alterado.';
}
export function personalControlWord(text:string):'approve'|'discard'|'stop'|'team'|null{
 const word=text.trim().toLowerCase();
 if(word==='aprovar'||word==='approve')return 'approve';
 if(word==='descartar'||word==='discard')return 'discard';
 if(word==='equipe'||word==='status'||word==='team')return 'team';
 if(word==='pare'||word==='parar'||word==='cancelar'||word==='stop')return 'stop';
 return null;
}
export function personalProgressLabel(state:string){
 if(state==='failed')return 'falhou';
 if(state==='done'||state==='integrated')return 'integrado';
 if(state==='review')return 'revisão';
 if(state==='qa')return 'QA';
 if(state==='running')return 'programando';
 return 'na fila';
}
