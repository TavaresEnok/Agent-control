import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {closeHead, createRefusal, execRefusal, installationRoots, routeRefusal, startDockerFilter, strictJsonParse} from '../src/docker-filter.ts';
import {symlink, writeFile} from 'node:fs/promises';
import {connect, createServer} from 'node:net';

const policy = {allowedRoots: ['/home/app/.agent-control/ispagent', '/tmp']};

test('only the routes the product uses pass', () => {
  for (const [method, path] of [['GET', '/v1.44/containers/abc/json'], ['POST', '/v1.44/containers/create?name=x'], ['POST', '/containers/abc/attach?stream=1'],
    ['DELETE', '/v1.44/containers/abc'], ['GET', '/v1.44/images/sha256:abc/json'], ['POST', '/v1.44/networks/create'], ['GET', '/_ping'], ['GET', '/v1.44/containers/abc/logs?stdout=1']])
    assert.equal(routeRefusal(method!, path!), null, `${method} ${path}`);
  for (const [method, path] of [['POST', '/v1.44/build'], ['POST', '/v1.44/images/create'],
    ['PUT', '/v1.44/containers/abc/archive'], ['POST', '/v1.44/plugins/pull'], ['POST', '/v1.44/swarm/init'], ['GET', '/v1.44/containers/../../json'], ['POST', '/v1.44/volumes/create']])
    assert.notEqual(routeRefusal(method!, path!), null, `${method} ${path}`);
});

test('a container create that asks for privilege or a host path outside the roots is refused', () => {
  const ok = {Image: 'sha256:a', HostConfig: {Binds: ['/home/app/.agent-control/ispagent/execution-host/j/work:/work:ro', 'named-volume:/data'], Mounts: [{Type: 'tmpfs', Target: '/tmp'}], NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true']}};
  assert.equal(createRefusal(ok, policy), null);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{Privileged: true}, /Privileged/], [{CapAdd: ['SYS_ADMIN']}, /CapAdd/], [{Devices: [{PathOnHost: '/dev/sda'}]}, /Devices/],
    [{NetworkMode: 'host'}, /NetworkMode=host/], [{PidMode: 'host'}, /PidMode=host/], [{UsernsMode: 'host'}, /UsernsMode=host/],
    [{SecurityOpt: ['seccomp=unconfined']}, /SecurityOpt/], [{SecurityOpt: ['seccomp={"defaultAction":"SCMP_ACT_ALLOW"}']}, /SecurityOpt/],
    [{MaskedPaths: []}, /MaskedPaths/], [{ReadonlyPaths: []}, /ReadonlyPaths/], [{PidMode: 'container:abc'}, /PidMode=container/],
    [{DeviceRequests: [{Count: -1}]}, /DeviceRequests/], [{GroupAdd: ['docker']}, /GroupAdd/], [{Runtime: 'sysbox'}, /Runtime/],
    [{CgroupParent: '/'}, /CgroupParent/], [{Sysctls: {'kernel.x': '1'}}, /Sysctls/], [{CapAdd: ['DAC_OVERRIDE', 'SYS_PTRACE']}, /CapAdd/],
    [{SomethingNew: true}, /campo não permitido: HostConfig\.SomethingNew/], [{Binds: ['/tmp/x:/x:rshared']}, /propagação/], [{SecurityOpt: ['apparmor:unconfined']}, /SecurityOpt/], [{VolumesFrom: ['other']}, /VolumesFrom/],
    [{Binds: ['/:/host']}, /proibida/], [{Binds: ['/var/run/docker.sock:/var/run/docker.sock']}, /proibida/], [{Binds: ['/etc:/x:ro']}, /proibida/],
    [{Binds: ['/home/app/.ssh:/x']}, /fora das raízes/], [{Mounts: [{Type: 'bind', Source: '/root', Target: '/x'}]}, /proibida/],
    [{Binds: ['/home/app/.agent-control/ispagent/../../.ssh:/x']}, /fora das raízes/],
    [{Mounts: [{Type: 'volume', Source: 'v', Target: '/x', VolumeOptions: {DriverConfig: {Name: 'local', Options: {type: 'none', o: 'bind', device: '/etc'}}}}]}, /opções de driver/],
  ];
  for (const [host, reason] of bad) assert.match(createRefusal({HostConfig: host}, policy) ?? '', reason, JSON.stringify(host));
  assert.match(createRefusal('x', policy)!, /corpo inválido/);
  assert.equal(createRefusal({Image: 'x', HostConfig: {CapDrop: ['ALL'], CapAdd: ['DAC_OVERRIDE', 'FOWNER'], SecurityOpt: ['no-new-privileges'], MaskedPaths: null}}, policy), null);
  assert.match(createRefusal({Image: 'x', Privileged: true}, policy)!, /campo não permitido: Privileged/);
});

test('keys repeated or differing only in case are refused before the field checks', () => {
  assert.throws(() => strictJsonParse('{"Image":"x","hostconfig":{"privileged":true},"HostConfig":{}}'), /JSON_NOT_STRICT/);
  assert.throws(() => strictJsonParse('{"HostConfig":{"Privileged":true},"HostConfig":{}}'), /JSON_NOT_STRICT/);
  assert.throws(() => strictJsonParse('{"a":1} trailing'), /JSON_NOT_STRICT/);
  assert.deepEqual(strictJsonParse('{"a":[1,{"b":"c\\"d"}],"e":null}'), {a: [1, {b: 'c"d'}], e: null});
  // A lower-case field name alone is not a known Docker field here: the allowlist refuses it.
  assert.match(createRefusal({Image: 'x', hostconfig: {privileged: true}}, policy)!, /campo não permitido: hostconfig/);
});

test('exec is allowed only for the QA database probe', () => {
  assert.equal(execRefusal({AttachStdout: false, AttachStderr: false, Tty: false, Cmd: ['pg_isready', '-h', '127.0.0.1']}), null);
  assert.match(execRefusal({Cmd: ['sh', '-c', 'id']})!, /pg_isready/);
  assert.match(execRefusal({Cmd: ['pg_isready'], Privileged: true})!, /campo não permitido: Privileged/);
});

test('a symlink inside an allowed root cannot point a mount at the host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-filter-link-'));
  try {
    await symlink('/etc', join(dir, 'etc-link'));
    await symlink('/home', join(dir, 'home-link'));
    assert.match(createRefusal({HostConfig: {Binds: [`${join(dir, 'etc-link')}:/x`]}}, {allowedRoots: [dir]})!, /proibida/);
    assert.match(createRefusal({HostConfig: {Mounts: [{Type: 'bind', Source: join(dir, 'home-link', 'app'), Target: '/x'}]}}, {allowedRoots: [dir]})!, /fora das raízes/);
    assert.equal(createRefusal({HostConfig: {Binds: [`${join(dir, 'novo', 'sub')}:/x`]}}, {allowedRoots: [dir]}), null);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('roots come from the installation: data, accounts, /tmp, project roots and repositories', () => {
  assert.deepEqual(installationRoots({dataDirectory: '/d', accountHomesDirectory: '/d/accounts', projectRoots: [{path: '/p'}], project: {repo: '/p/a'}, projects: [{repo: '/x/b'}, {repo: '/'}]}),
    ['/d', '/d/accounts', '/tmp', '/p', '/p/a', '/x/b']);
});

test('an Upgrade header outside attach cannot carry a second request past the check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acf-'));
  const upstreamPath = join(dir, 'u.sock'), listen = join(dir, 'f.sock');
  const received: string[] = [];
  const upstream = createServer(socket => { socket.on('data', chunk => received.push(chunk.toString('latin1'))); socket.on('end', () => socket.end()); });
  await new Promise<void>(resolve => upstream.listen(upstreamPath, () => resolve()));
  const server = await startDockerFilter(listen, upstreamPath, {allowedRoots: [dir]}, () => {});
  try {
    const smuggled = 'GET /_ping HTTP/1.1\r\nHost: d\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n' +
      'POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n{"HostConfig":{"Privileged":true}}      ';
    await new Promise<void>(resolve => { const c = connect(listen, () => { c.write(smuggled); setTimeout(() => { c.destroy(); resolve(); }, 300); }); });
    const text = received.join('');
    assert.match(text, /^GET \/_ping HTTP\/1\.1\r\nHost: d\r\nConnection: close\r\n\r\n/);
    assert.doesNotMatch(text, /Upgrade: tcp/);
  } finally {
    server.close(); upstream.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test('ordinary requests are forced to Connection: close; an upgrade keeps its headers', () => {
  assert.equal(closeHead('GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive'), 'GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close');
  const upgrade = 'POST /v1.44/containers/a/attach?stream=1 HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: tcp';
  assert.equal(closeHead(upgrade), upgrade);
  assert.equal(closeHead('GET /_ping HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: tcp'), 'GET /_ping HTTP/1.1\r\nConnection: close');
});

const lab = process.env.AC_DOCKER_FILTER_LAB === '1' ? test : test.skip;
lab('lab: the real Docker CLI runs, attaches and is refused through the filter', async () => {
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'ac-docker-filter-'));
  await mkdir(join(dir, 'ok'));
  const socket = join(dir, 'f.sock');
  const server = await startDockerFilter(socket, '/var/run/docker.sock', {allowedRoots: [dir]}, () => {});
  const env = {...process.env, DOCKER_HOST: 'unix://' + socket};
  try {
    const image = process.env.AC_DOCKER_FILTER_IMAGE ?? 'alpine:latest';
    assert.equal((await run('docker', ['run', '--rm', '--network', 'none', '-v', `${join(dir, 'ok')}:/x:ro`, image, 'echo', 'hi'], {env})).stdout.trim(), 'hi');
    for (const args of [['--privileged'], ['-v', '/etc:/x'], ['--network', 'host'], ['--cap-add', 'SYS_ADMIN']])
      await assert.rejects(run('docker', ['run', '--rm', ...args, image, 'true'], {env}), /agent-control docker filter/);
  } finally {
    server.close();
    await rm(dir, {recursive: true, force: true});
  }
});
