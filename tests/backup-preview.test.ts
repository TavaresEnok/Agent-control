import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectBackupManifest,BACKUP_MANIFEST_LIMIT} from '../upstream/cezar/packages/web/src/routes/settings/agent-control-backup-preview.ts';
const fixture={schemaVersion:1,scope:'isolated-synthetic-lab',backupId:'synthetic-backup',root:'/private/root',createdAt:'2026-11-02T10:00:00.000Z',commit:'a'.repeat(40),sources:['.state/happier'],missingOptional:['.state/keys'],files:[{path:'.state/happier/private-file',size:12,sha256:'b'.repeat(64)}],databaseSha256:'c'.repeat(64),limitation:'synthetic only'};
const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
test('backup preview never exposes paths, verifies no archive and rejects dangerous manifest inputs',async()=>{
 const report=await inspectBackupManifest(encode(fixture));assert.equal(report.counts.sourceBytes,12);assert.equal(report.restoreEnabled,false);assert.equal(report.checks.archiveAuthenticated,false);
 for(const value of ['/private/root','private-file','synthetic-backup','b'.repeat(64),'c'.repeat(64)])assert.ok(!JSON.stringify(report).includes(value));
 await assert.rejects(inspectBackupManifest(encode({...fixture,files:[{...fixture.files[0],path:'../../secret'}]})));
 await assert.rejects(inspectBackupManifest(encode({...fixture,files:[fixture.files[0],fixture.files[0]]})));
 await assert.rejects(inspectBackupManifest(new Uint8Array(BACKUP_MANIFEST_LIMIT+1)));
});
