import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {closeHead, createRefusal, routeRefusal, startDockerFilter} from '../src/docker-filter.ts';

const policy = {allowedRoots: ['/home/app/.agent-control/ispagent', '/tmp']};

test('only the routes the product uses pass', () => {
  for (const [method, path] of [['GET', '/v1.44/containers/abc/json'], ['POST', '/v1.44/containers/create?name=x'], ['POST', '/containers/abc/attach?stream=1'],
    ['DELETE', '/v1.44/containers/abc'], ['GET', '/v1.44/images/sha256:abc/json'], ['POST', '/v1.44/networks/create'], ['GET', '/_ping'], ['GET', '/v1.44/containers/abc/logs?stdout=1']])
    assert.equal(routeRefusal(method!, path!), null, `${method} ${path}`);
  for (const [method, path] of [['POST', '/v1.44/containers/abc/exec'], ['POST', '/v1.44/exec/abc/start'], ['POST', '/v1.44/build'], ['POST', '/v1.44/images/create'],
    ['PUT', '/v1.44/containers/abc/archive'], ['POST', '/v1.44/plugins/pull'], ['POST', '/v1.44/swarm/init'], ['GET', '/v1.44/containers/../../json'], ['POST', '/v1.44/volumes/create']])
    assert.notEqual(routeRefusal(method!, path!), null, `${method} ${path}`);
});

test('a container create that asks for privilege or a host path outside the roots is refused', () => {
  const ok = {Image: 'sha256:a', HostConfig: {Binds: ['/home/app/.agent-control/ispagent/execution-host/j/work:/work:ro', 'named-volume:/data'], Mounts: [{Type: 'tmpfs', Target: '/tmp'}], NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true']}};
  assert.equal(createRefusal(ok, policy), null);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{Privileged: true}, /Privileged/], [{CapAdd: ['SYS_ADMIN']}, /CapAdd/], [{Devices: [{PathOnHost: '/dev/sda'}]}, /Devices/],
    [{NetworkMode: 'host'}, /NetworkMode=host/], [{PidMode: 'host'}, /PidMode=host/], [{UsernsMode: 'host'}, /UsernsMode=host/],
    [{SecurityOpt: ['seccomp=unconfined']}, /SecurityOpt/], [{SecurityOpt: ['apparmor:unconfined']}, /SecurityOpt/], [{VolumesFrom: ['other']}, /VolumesFrom/],
    [{Binds: ['/:/host']}, /proibida/], [{Binds: ['/var/run/docker.sock:/var/run/docker.sock']}, /proibida/], [{Binds: ['/etc:/x:ro']}, /proibida/],
    [{Binds: ['/home/app/.ssh:/x']}, /fora das raízes/], [{Mounts: [{Type: 'bind', Source: '/root', Target: '/x'}]}, /proibida/],
    [{Binds: ['/home/app/.agent-control/ispagent/../../.ssh:/x']}, /fora das raízes/],
    [{Mounts: [{Type: 'volume', Source: 'v', Target: '/x', VolumeOptions: {DriverConfig: {Name: 'local', Options: {type: 'none', o: 'bind', device: '/etc'}}}}]}, /opções de driver/],
  ];
  for (const [host, reason] of bad) assert.match(createRefusal({HostConfig: host}, policy) ?? '', reason, JSON.stringify(host));
  assert.match(createRefusal('x', policy)!, /corpo inválido/);
});

test('ordinary requests are forced to Connection: close; an upgrade keeps its headers', () => {
  assert.equal(closeHead('GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive'), 'GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close');
  const upgrade = 'POST /containers/a/attach HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: tcp';
  assert.equal(closeHead(upgrade), upgrade);
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
