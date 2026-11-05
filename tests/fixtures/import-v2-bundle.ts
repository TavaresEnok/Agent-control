import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {convertPaseoOfflineHistory} from '../../src/paseo-history-converter.ts';
import type {HappierBoundary} from '../../src/happier.ts';
import {keyFingerprint} from '../../src/context-keys.ts';

/** Offline synthetic Paseo-shaped source; no installed Paseo/service is read. */
export async function historicalBundle(projectId:string,sessionId:string,key:Uint8Array,boundary:HappierBoundary){
 const source=JSON.parse(await readFile(new URL('./import-v2/paseo-offline.json',import.meta.url),'utf8'));
 const converted=convertPaseoOfflineHistory(source);
 const text='Synthetic historical conversation, kept encrypted.';
 return {schemaVersion:2 as const,importId:randomUUID(),projectId,sourceNamespace:'offline-paseo-'+randomUUID(),contexts:[{id:'context-original-1',sessionId,sourcePaused:false,keyVariant:'legacy' as const,keyFingerprint:keyFingerprint(key),
  messages:[{id:'message-original-1',ciphertext:boundary.encodeBase64(boundary.encrypt(key,'legacy',{role:'user',content:{type:'text',text}}))}],
  runs:converted.runs,history:converted.history}]};
}
