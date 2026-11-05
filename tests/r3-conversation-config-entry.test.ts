import {test} from 'node:test';
import assert from 'node:assert/strict';
import linkModule from '../upstream/happier/apps/ui/sources/components/sessions/actions/agentControlConfigurationLink.ts';
import {conversationConfigurationEntry,conversationConfigurationContext} from '../upstream/cezar/packages/web/src/routes/settings/agent-control-conversation-entry.ts';

const {agentControlConfigurationLink}=linkModule;

test('conversation action opens only configured control origin and pins exact session across panel selection',()=>{
 const destination=agentControlConfigurationLink('https://control.example.invalid','session/a+b');
 assert(destination);const url=new URL(destination);
 assert.equal(url.origin,'https://control.example.invalid');assert.equal(url.pathname,'/settings/agent-control');assert.equal(url.searchParams.get('acSession'),'session/a+b');
 for(const origin of [undefined,'javascript:alert(1)','http://external.example.invalid','https://user:secret@example.invalid','https://example.invalid/path','https://example.invalid/?query=1'])assert.equal(agentControlConfigurationLink(origin,'session'),null);
 assert(agentControlConfigurationLink('http://127.0.0.1:4311','session'));
 assert.equal(agentControlConfigurationLink('https://control.example.invalid',''),null);
 const contexts=[{id:'first',session_id:'other'},{id:'second',session_id:'session/a+b'}];
 const entry=conversationConfigurationEntry(url.search);
 assert.equal(conversationConfigurationContext(contexts,'first',entry),'second');
 assert.equal(conversationConfigurationContext(contexts,'first',conversationConfigurationEntry('?acSession=missing')),'');
 assert.equal(conversationConfigurationContext(contexts,'first',conversationConfigurationEntry('?acSession=%00')),'');
 assert.equal(conversationConfigurationContext(contexts,'second',conversationConfigurationEntry('')),'second');
});
