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
 const mega=builtinCombos.find(combo=>combo.name==='megapoderoso');
 assert.ok(mega);
 const text=formatListedCombo(mega,false);
 assert.match(text,/^megapoderoso\n/);
 assert.match(text,/Gerente: 1 × claude · claude-opus-5-5 · xhigh/);
 assert.match(text,/Programadores padrão: 4 × codex · gpt-6\.1-sol · high/);
 assert.match(text,/Programadores básicos: 2 × grok · grok-4\.7 · high/);
 assert.match(text,/QA: 1 × claude · claude-opus-5-5 · medium/);
 const current=formatListedCombo(builtinCombos[0]!,true);
 assert.match(current,/^padrão \(em uso\)/);
 assert.match(current,/QA: script automático do projeto \(sem modelo\)/);
});
