const CHANGE=/\b(adicione|adicionar|crie|criar|implemente|implementar|corrija|corrigir|remova|remover|atualize|atualizar|refatore|mude|altere|inclua|faça|faz|add|create|implement|fix|remove|update|refactor)\b/i;
export function classifyPersonalText(text:string):'answer'|'plan'{
 const trimmed=text.trim();
 if(CHANGE.test(trimmed))return 'plan';
 if(trimmed.endsWith('?')||/^(o que|qual|quais|quem|como|por que|porque|quando|onde|explique|resuma|what|why|how|when|where)\b/i.test(trimmed))return 'answer';
 return 'plan';
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
