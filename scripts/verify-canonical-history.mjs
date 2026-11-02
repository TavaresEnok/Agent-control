import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {decrypt,decodeBase64} from '../upstream/happier/node_modules/.agent-control-boundary.mjs';
const f=JSON.parse(fs.readFileSync('.state/browser-fixture.json','utf8'));
const db=new DatabaseSync('.state/happier/server.sqlite',{readOnly:true});
const key=Buffer.from(f.secret,'base64url');const result=[];
for(let index=0;index<f.sessions.length;index++){
 const rows=db.prepare('SELECT content FROM SessionMessage WHERE sessionId=?').all(f.sessions[index]);
 const decoded=rows.map(row=>{const e=JSON.parse(row.content);assert.equal(e.t,'encrypted');return decrypt(key,'legacy',decodeBase64(e.c))});
 const users=decoded.filter(m=>m?.role==='user');
 assert.equal(users.length,index===0?2:1);
 const ids=users.map(m=>m.localKey);assert.equal(new Set(ids).size,users.length);
 assert(!JSON.stringify(users).includes(index===0?'relatórios verdes':'painel azul'));
 result.push({session:f.sessions[index],encryptedMessages:rows.length,userMessages:users.length,duplicateUserMessages:0});
}
db.close();fs.writeFileSync('docs/validation/evidence/canonical-history-final.json',JSON.stringify({result:'passed',sessions:result,scope:'Read-only verification of the actual Happier SQLite transcript after final browser proof, using native Happier decryption.'},null,2));
