import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer, type IncomingMessage} from 'node:http';
import {join} from 'node:path';
import {AccountHomes} from '../../src/account-homes.ts';
import {Capacity} from '../../src/capacity.ts';
import {digest} from '../../src/contracts.ts';
import type {Ledger} from '../../src/ledger.ts';
import type {ModuleExamProvider} from '../../src/module-exam-egress.ts';
import type {ModuleExamRuntime} from '../../src/module-exam-native.ts';
import {NativeExecutionSupervisor} from '../../src/native-execution-supervisor.ts';

type Mount = {Type: 'bind'; Source: string; Destination: string; RW: boolean};
type Config = {Image: string; Labels: Record<string, string>; Cmd: string[]; Env: string[]; Entrypoint: string[];
  User: string; WorkingDir: string; HostConfig: {NetworkMode: string; Binds: string[]}};
type Container = {Id: string; Image: string; Config: Config; HostConfig: Config['HostConfig'] & {PidMode: string; IpcMode: string; CapAdd: string[]; Devices: unknown[]; PortBindings: null}; Mounts: Mount[];
  NetworkSettings: {Networks: Record<string, {NetworkID: string; IPAddress: string}>};
  State: {Status: string; Running: boolean; FinishedAt: string; ExitCode: number}};
type Launch = {jobId: string; provider: ModuleExamProvider; task: string; moduleExam: boolean; role: string; writePaths: string[]};

async function fakeDocker(socket: string, answer: (launch: Launch) => {output: string; failureCode: string | null}) {
  const containers = new Map<string, Container>();
  const networks = new Map<string, {Name: string; Labels: Record<string, string>}>();
  const id = () => digest(randomUUID());
  const logs: Launch[] = [];
  const observations: Container[] = [];
  let releaseFailure: unknown;
  const end = (container: Container, exitCode: number) => {
    container.State = {Status: 'exited', Running: false, FinishedAt: new Date().toISOString(), ExitCode: exitCode};
  };
  async function body(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = createServer((request, response) => {
    const send = (status: number, data?: object) => {
      response.writeHead(status);
      response.end(data ? JSON.stringify(data) : '');
    };
    void (async () => {
      const url = new URL(request.url!, 'http://docker.invalid');
      const [kind, key, action] = url.pathname.split('/').slice(2);
      const method = request.method;
      if (kind === 'images') { send(200); return; }
      if (kind === 'networks') {
        if (key === 'create') {
          const value = await body(request), net = id();
          networks.set(net, {Name: value.Name, Labels: value.Labels});
          send(201, {Id: net}); return;
        }
        if (method === 'DELETE') { networks.delete(key!); send(204); return; }
        const network = networks.get(key!);
        if (!network) { send(404); return; }
        const peers = [...containers.values()].filter(c => c.HostConfig.NetworkMode === key);
        send(200, {...network, Id: key, Internal: true, Containers: Object.fromEntries(peers.map(c =>
          [c.Id, {IPv4Address: '172.20.0.3/16'}]))}); return;
      }
      if (kind !== 'containers') throw Error('unexpected fixture route');
      if (key === 'create') {
        const name = url.searchParams.get('name')!, config: Config = await body(request);
        const cid = id(), host = config.HostConfig;
        const mounts = host.Binds.map((bind): Mount => {
          const [Source, Destination, mode] = bind.split(':');
          return {Type: 'bind', Source: Source!, Destination: Destination!, RW: mode === 'rw'};
        });
        const attached: Container['NetworkSettings']['Networks'] = host.NetworkMode === 'none' ? {none: {NetworkID: '', IPAddress: ''}} : {job: {NetworkID: host.NetworkMode, IPAddress: '172.20.0.3'}};
        const container: Container = {Id: cid, Image: config.Image, Config: config,
          HostConfig: {...host, PidMode: '', IpcMode: 'private', CapAdd: [], Devices: [], PortBindings: null},
          Mounts: mounts, NetworkSettings: {Networks: attached},
          State: {Status: 'created', Running: false, FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0}};
        containers.set(name, container);
        observations.push(container);
        send(201, {Id: cid}); return;
      }
      const entry = [...containers.entries()].find(([name, c]) => name === key || c.Id === key);
      if (!entry) { send(404); return; }
      const [name, c] = entry;
      if (method === 'DELETE') { containers.delete(name); send(204); return; }
      if (action === 'start') { c.State = {...c.State, Status: 'running', Running: true}; send(204); return; }
      if (action === 'stop') { if (c.State.Running) end(c, 137); send(204); return; }
      if (action === 'logs') { send(200); return; }
      if (action !== 'json') throw Error('unexpected container operation');
      const input = c.Mounts.find(m => m.Destination === '/input')?.Source;
      const output = c.Mounts.find(m => m.Destination === '/output')?.Source;
      if (input && output && c.State.Running && name === key && existsSync(join(input, 'launch.json'))) {
        const launch: Launch = JSON.parse(await readFile(join(input, 'launch.json'), 'utf8')).payload;
        const result = answer(launch);
        logs.push(launch);
        const exitCode = result.failureCode ? 1 : 0;
        await writeFile(join(output, 'execution-result.json'), JSON.stringify({schemaVersion: 1, jobId: launch.jobId,
          ...result, normalizedTokensUsed: null, usageWindows: null, nativeSessionId: null, exitCode}), {mode: 0o600});
        end(c, exitCode);
      }
      send(200, c);
    })().catch(error => { releaseFailure = error; send(500); });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  return {logs, observations, containers, networks, check() { assert.equal(releaseFailure, undefined); },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}

type Answer = Parameters<typeof fakeDocker>[1];

export function moduleExamFixtureAnswer(launch: Launch): ReturnType<Answer> {
  const task = JSON.parse(launch.task);
  if (launch.provider === 'claude') {
    return {failureCode: null, output: JSON.stringify({kind: 'exame', filesRead: [task.file],
      checklist: [task.module], routesReviewed: [], findings: []})};
  }
  return {failureCode: null, output: JSON.stringify({kind: 'confirmacao', status: 'confirmado',
    binding: task.binding, proof: task.code, reason: 'A fixture registra `' + task.code + '` na linha indicada pela regra.'})};
}

/** Simulates only the Docker socket and inference output. Capacity and the native supervisor stay real. */
export async function createModuleExamFixture(input: {
  root: string; repo: string; ledger: Ledger; owner: string; project: string; answer?: Answer;
}) {
  const {root, repo, ledger, owner, project} = input;
  const hostRoot = join(root, 'fixture-spool'), accountRoot = join(root, 'fixture-accounts');
  for (const path of [hostRoot, accountRoot]) await mkdir(path, {mode: 0o700});
  const socket = join(root, 'fixture-docker.sock');
  const capacity = new Capacity(ledger);
  const image = 'sha256:' + 'd'.repeat(64);
  const signingKeyPem = generateKeyPairSync('ed25519').privateKey.export({format: 'pem', type: 'pkcs8'}).toString();
  const runtime: ModuleExamRuntime[number][] = [];
  const profiles = [];
  for (const provider of ['claude', 'codex'] as const) {
    const accountId = randomUUID(), profileId = randomUUID(), model = provider + '-module-fixture';
    const subject = 'account-synthetic-module-' + provider;
    const subjectDigest = digest({provider, subject});
    await capacity.registerModel(owner, {provider, model, efforts: ['medium'], roles: ['specialist'], source: 'synthetic://module-exam'});
    await capacity.addAccount(owner, project, {id: accountId, provider, label: provider, resourceIdentity: provider + ':' + subjectDigest,
      mode: 'subscription_cli', eligibility: 'documented_supported', eligibilitySource: 'synthetic://module-exam', maxConcurrent: 2});
    await capacity.addProfile(owner, project, {id: profileId, accountId, model, role: 'specialist', effort: 'medium'});
    await capacity.observeQuota(owner, accountId, {status: 'available', ttlSeconds: 3600, source: 'synthetic://module-exam'});

    await new AccountHomes(ledger, accountRoot, [repo]).initialize(owner, project, accountId);
    const account = join(accountRoot, accountId);
    if (provider === 'claude') {
      await writeFile(join(account, '.credentials.json'), JSON.stringify({claudeAiOauth: {
        accessToken: 'synthetic-claude-access-only-fixture', refreshToken: 'synthetic-claude-refresh-only-fixture',
        expiresAt: Date.now() + 3600_000}}), {mode: 0o600});
    } else {
      await mkdir(join(account, '.codex'), {mode: 0o700});
      await writeFile(join(account, '.codex', 'auth.json'), JSON.stringify({auth_mode: 'chatgpt',
        tokens: {account_id: subject, access_token: 'synthetic-codex-access-only-fixture', refresh_token: 'synthetic-codex-refresh-only-fixture'}}), {mode: 0o600});
    }
    runtime.push({provider, accountIds: new Set([accountId]), supervisor: new NativeExecutionSupervisor(ledger, {
      id: 'fixture-' + provider, provider, workerImage: image, toolsImage: image, hostRoot, accountRoot,
      protectedRepositories: [repo], signingKeyPem, providerNetworkId: 'e'.repeat(64), socketPath: socket,
      accountSubjects: [{accountId, subjectDigest}], workerEnv: [], toolsEnv: [],
    })});
    profiles.push(profileId);
  }
  const docker = await fakeDocker(socket, input.answer ?? moduleExamFixtureAnswer);
  return {runtime, profiles, docker};
}
