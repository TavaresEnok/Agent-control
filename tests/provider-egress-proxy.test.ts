import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

const proxy = new URL('../services/provider-egress/proxy.py', import.meta.url).pathname;
/** Runs target_from_header in the real proxy module, with the given environment, for each CONNECT host. */
function decide(env: Record<string, string>, hosts: string[]) {
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('proxy',${JSON.stringify(proxy)});m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
out=[]
for h in json.loads(sys.argv[1]):
  port=':443' if not h.startswith('noport:') else ''
  h=h.replace('noport:','')
  try: out.append(m.target_from_header(('CONNECT %s:443 HTTP/1.1\\r\\nHost: %s%s\\r\\n\\r\\n'%(h,h,port)).encode()))
  except ValueError: out.append(None)
print(json.dumps(out))`;
  const run = spawnSync('python3', ['-I', '-B', '-c', script, JSON.stringify(hosts)], {env: {PATH: '/usr/bin:/bin', ...env}, encoding: 'utf8'});
  return {status: run.status, decided: run.status === 0 ? JSON.parse(run.stdout) as (string | null)[] : null, stderr: run.stderr};
}

test('the locked default still allows only the two OpenAI hosts', () => {
  const {decided} = decide({}, ['chatgpt.com', 'auth.openai.com', 'api.anthropic.com', 'example.com', 'noport:chatgpt.com']);
  // undici sends Host without the port: still the same target.
  assert.deepEqual(decided, ['chatgpt.com', 'auth.openai.com', null, null, 'chatgpt.com']);
});

test('AC_EGRESS_ALLOW replaces the list and enforce mode names each refused host', () => {
  const {decided, stderr} = decide({AC_EGRESS_ALLOW: 'api.anthropic.com, platform.claude.com'}, ['api.anthropic.com', 'chatgpt.com', 'evil.example']);
  assert.deepEqual(decided, ['api.anthropic.com', null, null]);
  assert.match(stderr, /^egress-denied chatgpt\.com$/m);
  assert.match(stderr, /^egress-denied evil\.example$/m);
});

test('observe mode lets an unlisted host through and records only its name', () => {
  const {decided, stderr} = decide({AC_EGRESS_ALLOW: 'api.anthropic.com', AC_EGRESS_MODE: 'observe'}, ['api.anthropic.com', 'statsig.anthropic.com']);
  assert.deepEqual(decided, ['api.anthropic.com', 'statsig.anthropic.com']);
  assert.equal(stderr.trim(), 'egress-observe statsig.anthropic.com');
});

test('an invalid list or mode stops the proxy instead of allowing everything', () => {
  assert.notEqual(decide({AC_EGRESS_ALLOW: 'bad host!'}, []).status, 0);
  assert.notEqual(decide({AC_EGRESS_MODE: 'open'}, []).status, 0);
});

test('native workers and the planner apply the personal proxy decision', async () => {
  const worker = await readFile(new URL('../src/native-execution-worker.ts', import.meta.url), 'utf8');
  const decision = worker.indexOf('const personalEgress=personalEgressEnabled();');
  assert.ok(decision >= 0 && decision < worker.indexOf('initializeNativeWorkerEnvironment();'));
  assert.ok(worker.includes('initializeNativeWorkerEnvironment(personalCli&&!personalEgress?undefined:input.proxyUrl);'));
  const supervisor = await readFile(new URL('../src/native-execution-supervisor.ts', import.meta.url), 'utf8');
  assert.match(supervisor, /if\(personal&&!synthetic&&!input\.moduleExam\)\s*\{[^}]*if\(this\.config\.personalEgress\?\?personalEgressEnabled\(\)\)workerEnv\.push\('AC_PERSONAL_EGRESS=1'\);/);
  const planner = await readFile(new URL('../src/native-planning-supervisor.ts', import.meta.url), 'utf8');
  assert.ok(planner.includes('const useProxy=!personal||(this.config.personalEgress??personalEgressEnabled());'));
  assert.ok(planner.includes("...(useProxy?{proxyUrl:'http://provider-egress:8080' as const}:{})"));
});
