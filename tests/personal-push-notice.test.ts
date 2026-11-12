import {test} from 'node:test';
import assert from 'node:assert/strict';
import {personalPushBody} from '../src/personal-push.ts';

test('a personal push notice covers the five manager cases and stays quiet otherwise',()=>{
 const cases:[string,boolean][]=[
  ['Proposta de plano 4.\nResponda aprovar para iniciar ou descartar para ignorar.',false],
  ['Plano 2: execução concluída; confira o artefato e a integração.',false],
  ['A tarefa api falhou. Pedi ao gerente um plano corrigido.',false],
  ['Atenção — 1 bloqueio(s):\n- Plano 1: execução falhou; consultar diagnóstico.',false],
  ['O repositório tem três módulos.',true],
 ];
 for(const [text,reply] of cases){
  const body=personalPushBody(text,reply);
  assert.equal(typeof body,'string');
  assert.equal(body,text.trim().split('\n')[0]!.trim().slice(0,140));
 }
 assert.equal(personalPushBody('Etapa programação em andamento.',false),null);
 const long='Proposta de plano '+ 'a'.repeat(200);
 const clipped=personalPushBody(long,false);
 assert.equal(clipped?.length,140);
 assert.equal(personalPushBody('Veja a Proposta de plano depois.',false),null);
 assert.equal(personalPushBody('Tudo certo\nA etapa falhou.',false),'Tudo certo');
});
