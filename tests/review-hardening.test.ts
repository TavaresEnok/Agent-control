import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelDisabledByPolicy} from '../src/model-policy.ts';
import {UNSAFE_SEMANTIC_TEXT,unsafeText} from '../src/config-export.ts';

test('forbidden model aliases are refused with provider, tag and version decorations',()=>{
 for(const model of ['astra','gpt-6-astra','openai/astra:preview','codex:astra:latest','gpt-6-astra-preview','astra@1','GPT-6.1-Astra'])assert.equal(modelDisabledByPolicy(model),true,model);
 for(const model of ['unknown-astra-alias','gpt-6.1-sol','claude-haiku-5-5','gpt-6-luna'])assert.equal(modelDisabledByPolicy(model),false,model);
});

test('portable text refuses common credential shapes',()=>{
 const tail='A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
 for(const text of ['AKIA'+'IOSFODNN7EXAMPLE','AWS_SECRET_ACCESS_KEY=abc','OPENAI_API_KEY=abcd1234','api_key: abc123','X-Api-Key: zzz','api_key: correct-horse-battery-staple','"api_key": "abcdefghijkl"','secret_key: AbCdEfGhIjKl','apikey=sk','redis://:pw@h:6379','Authorization: Basic abc','glpat-'+tail,'AIza'+tail+'abcdefgh','postgres://u:p@h/db','eyJhbGciOi'+'J.eyJzdWIiOi'+'J.sig'])assert.match(text,UNSAFE_SEMANTIC_TEXT,text);
 for(const text of ['Monkey wrench','keyboard layout','Review the access policy','https://example.com/docs','task: run tests','git clone ssh://git@github.com/org/repo.git','--max_key=3','PRIMARY_KEY= id','sort_key=name','Authorization: check roles before editing','Implement the authorization: policy'])assert.doesNotMatch(text,UNSAFE_SEMANTIC_TEXT,text);
});


test('portable text refuses bypasses found by independent review',()=>{
 const hits=['"password":"hunter2"','"password" : "hunter2"','passwd=hunter2','pwd=hunter2','pass: hunter2','DB_PASS=hunter2','api key: abc123','wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY','eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxIn0',
  'sk_live_'+'abcdefghijkl','xapp-1-A0-123-abc','npm_'+'a'.repeat(24),'SG.abcdefghijk.lmnop','shpat_abc','dop_v1_abc','pypi-AgEIcHlwaS5vcmc','ghp-abc',
  'https://hooks.slack.com/services/T000/B000/XXXX','https://discord.com/api/webhooks/123/abcdef','https://x.test/a?sig=abc','https://x.test/a?X-Amz-Signature=abc','https://x.test/a?code=abc',
  'ssh-rsa AAAAB3NzaC1yc2E','ssh-ed25519 AAAAC3Nza','MIIEvQIBADANBgkqhkiG9w0BAQEFAASC','-----BEGIN RSA PRIVATE KEY-----','g'.repeat(64),'A1b2C3d4'.repeat(6),
  'p\u0430ssword: x','pass\u200Bword: x','\uFF21\uFF2B\uFF29\uFF21IOSFODNN7EXAMPLE','Password\uFF1Ahunter2'];
 for(const text of hits)assert.equal(unsafeText(text),true,text);
 for(const text of ['Monkey wrench','bypass the cache','a'.repeat(0)+'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855','550e8400-e29b-41d4-a716-446655440000','Review the access policy'])assert.equal(unsafeText(text),false,text);
});
