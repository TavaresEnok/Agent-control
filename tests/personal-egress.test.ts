import test from 'node:test';
import assert from 'node:assert/strict';
import {EGRESS_CONTAINER, EgressConfig, ensurePersonalEgress, PERSONAL_EGRESS_HOSTS, PROVIDER_NETWORK} from '../src/personal-egress.ts';
import {Installation} from '../src/installation.ts';

const root = new URL('..', import.meta.url).pathname;
function fakeDocker(state: {internal: boolean | null; attached: string[]; label?: string}) {
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    calls.push(args);
    const [verb, sub] = args;
    if (verb === 'image' && sub === 'inspect') return '[]';
    if (verb === 'network' && sub === 'inspect') {
      if (state.internal === null) throw Error('no network');
      return JSON.stringify([{Internal: state.internal, Containers: Object.fromEntries(state.attached.map((name, i) => [String(i), {Name: name}]))}]);
    }
    if (verb === 'network' && sub === 'rm') { state.internal = null; return ''; }
    if (verb === 'network' && sub === 'create') { state.internal = true; return 'id'; }
    if (verb === 'inspect') { if (!state.label) throw Error('absent'); return state.label; }
    return '';
  };
  return {calls, run};
}

test('off does nothing; the installation accepts the egress block and refuses unknown keys', () => {
  assert.deepEqual(ensurePersonalEgress(root, {mode: 'off'}, () => { throw Error('no docker call expected'); }), []);
  assert.equal(EgressConfig.parse({mode: 'observe'}).mode, 'observe');
  assert.throws(() => EgressConfig.parse({mode: 'observe', open: true}));
  assert.throws(() => EgressConfig.parse({mode: 'enforce', allow: ['not a host']}));
  assert.equal(Installation.shape.egress !== undefined, true);
});

test('a non-internal provider network with nothing attached becomes internal and gets the proxy with the provider list', () => {
  const docker = fakeDocker({internal: false, attached: []});
  const done = ensurePersonalEgress(root, {mode: 'observe'}, docker.run);
  assert.ok(docker.calls.some(args => args.join(' ') === `network rm ${PROVIDER_NETWORK}`));
  assert.ok(docker.calls.some(args => args[0] === 'network' && args[1] === 'create' && args.includes('--internal')));
  const runArgs = docker.calls.find(args => args[0] === 'run')!;
  assert.ok(runArgs.includes('--read-only') && runArgs.includes('--cap-drop') && runArgs.includes('bridge'));
  assert.ok(runArgs.includes('AC_EGRESS_ALLOW=' + PERSONAL_EGRESS_HOSTS.join(',')));
  assert.ok(runArgs.includes('AC_EGRESS_MODE=observe'));
  assert.ok(docker.calls.some(args => args.join(' ') === `network connect --alias provider-egress ${PROVIDER_NETWORK} ${EGRESS_CONTAINER}`));
  assert.ok(done.some(line => line.startsWith('rede interna')));
});

test('a network with a job attached is never recreated', () => {
  const docker = fakeDocker({internal: false, attached: ['ac-native-worker-x']});
  assert.throws(() => ensurePersonalEgress(root, {mode: 'enforce'}, docker.run), /PROVIDER_NETWORK_BUSY ac-native-worker-x/);
  assert.ok(!docker.calls.some(args => args[0] === 'network' && args[1] === 'rm'));
});

test('an internal network with the same proxy running is left alone', () => {
  const first = fakeDocker({internal: true, attached: [EGRESS_CONTAINER]});
  ensurePersonalEgress(root, {mode: 'enforce'}, first.run);
  const label = first.calls.find(args => args[0] === 'run')!.find(arg => arg.startsWith('agent-control.egress='))!.split('=')[1];
  const second = fakeDocker({internal: true, attached: [EGRESS_CONTAINER], label: `${label} true`});
  assert.deepEqual(ensurePersonalEgress(root, {mode: 'enforce'}, second.run), []);
  assert.ok(!second.calls.some(args => args[0] === 'run' || args[1] === 'rm'));
});
