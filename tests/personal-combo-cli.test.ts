import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {builtinCombos} from '../src/personal-combos.ts';
import {formatListedCombo,runPersonalComboCli} from '../src/personal-combo-cli.ts';

test('combo cli usage refuses before opening an installation',async()=>{
 const usage=(error:unknown)=>error instanceof Refusal&&error.code==='COMBO_USAGE';
 await assert.rejects(runPersonalComboCli([]),usage);
 await assert.rejects(runPersonalComboCli(['instalacao.json','IspAgent']),usage);
 await assert.rejects(runPersonalComboCli(['instalacao.json','IspAgent','apply']),usage);
 await assert.rejects(runPersonalComboCli(['instalacao.json','IspAgent','list','extra']),usage);
 await assert.rejects(runPersonalComboCli(['--help','IspAgent','list']),usage);
 await assert.rejects(runPersonalComboCli(['instalacao.json','IspAgent','apply','nome','extra']),usage);
});

test('listed combo names each role and marks the current one',()=>{
 const combo=builtinCombos.find(item=>item.name==='complexo');
 assert.ok(combo);
 const text=formatListedCombo(combo,false);
 assert.match(text,/^complexo\n/);
 assert.match(text,/Gerente: 1 × claude · claude-opus-5-5 · high; reserva: codex · gpt-6\.1-sol · high/);
 assert.match(text,/Programadores padrão: 3 × codex · gpt-6\.1-sol · high/);
 assert.match(text,/Programadores básicos: 1 × claude · claude-sonnet-5-5 · high/);
 assert.match(text,/QA: 1 × claude · claude-sonnet-5-5 · high/);
 const current=formatListedCombo(builtinCombos.find(item=>item.name==='economia')!,true);
 assert.match(current,/^economia \(em uso\)/);
 assert.match(current,/QA: script automático do projeto \(sem modelo\)/);
});
