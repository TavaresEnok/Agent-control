import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import tls from 'node:tls';
import {after, before, test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {parseDesignArgs} from '../src/design-command.ts';
import {designRunArguments, designTrustArguments, DESIGN_TRUST_CA_MOUNT} from '../src/design-image.ts';
import {normalizeDesignTrustCa, readDesignTrustCa, stageDesignTrustCa} from '../src/design-trust.ts';
// @ts-expect-error módulo da imagem, em JavaScript puro
import {spkiHash, trustFlags, verifiedTrustFlags} from '../deploy/design-tools/trust.mjs';

const refusal = (code: string) => (error: unknown) => error instanceof Refusal && error.code === code;
const dir = mkdtempSync(join(tmpdir(), 'design-trust-test-'));
const ssl = (...args: string[]) => {
  const run = spawnSync('openssl', args, {cwd: dir, encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
};
let caPem = '';
let otherCaPem = '';
let leafPem = '';
let server: tls.Server;
let port = 0;

before(async () => {
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
    '-days', '2', '-subj', '/CN=Homologacao CA', '-addext', 'basicConstraints=critical,CA:TRUE');
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'outra.key', '-out', 'outra.pem',
    '-days', '2', '-subj', '/CN=Outra CA', '-addext', 'basicConstraints=critical,CA:TRUE');
  ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost\n');
  ssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf');
  caPem = readFileSync(join(dir, 'ca.pem'), 'utf8');
  otherCaPem = readFileSync(join(dir, 'outra.pem'), 'utf8');
  leafPem = readFileSync(join(dir, 'leaf.pem'), 'utf8');
  server = tls.createServer({key: readFileSync(join(dir, 'leaf.key')), cert: leafPem + caPem}, socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as {port: number}).port;
});

after(() => {
  server?.close();
  rmSync(dir, {recursive: true, force: true});
});

test('a cadeia que fecha na CA vira a flag com as chaves exatas dela', async () => {
  const flags = await verifiedTrustFlags(`https://localhost:${port}`, caPem, 5000);
  assert.equal(flags.length, 1);
  const hashes = (flags[0] as string).replace('--ignore-certificate-errors-spki-list=', '').split(',');
  assert.ok(hashes.includes(spkiHash(leafPem)));
  assert.ok(hashes.includes(spkiHash(caPem)));
});

test('outra CA, outro nome ou HTTP são recusados', async () => {
  await assert.rejects(verifiedTrustFlags(`https://localhost:${port}`, otherCaPem, 5000), /DESIGN_TRUST_CA_FAILED/);
  await assert.rejects(verifiedTrustFlags(`https://127.0.0.1:${port}`, caPem, 5000), /DESIGN_TRUST_CA_FAILED/);
  await assert.rejects(verifiedTrustFlags(`http://localhost:${port}`, caPem, 5000), /DESIGN_TRUST_CA_FAILED/);
});

test('sem DESIGN_TRUST_CA nada muda; caminho fora do fixo é recusado', async () => {
  assert.deepEqual(await trustFlags('https://app.local', {}), []);
  await assert.rejects(trustFlags('https://app.local', {DESIGN_TRUST_CA: '/etc/passwd'}), /DESIGN_TRUST_CA_FAILED/);
});

test('o arquivo de --ca aceita só certificados de CA', async () => {
  assert.match(normalizeDesignTrustCa(caPem), /^-----BEGIN CERTIFICATE-----/);
  assert.throws(() => normalizeDesignTrustCa(leafPem), refusal('DESIGN_TRUST_CA_INVALID'));
  assert.throws(() => normalizeDesignTrustCa(readFileSync(join(dir, 'ca.key'), 'utf8') + caPem), refusal('DESIGN_TRUST_CA_INVALID'));
  assert.throws(() => normalizeDesignTrustCa('texto solto\n' + caPem), refusal('DESIGN_TRUST_CA_INVALID'));
  assert.throws(() => normalizeDesignTrustCa(''), refusal('DESIGN_TRUST_CA_INVALID'));
  symlinkSync(join(dir, 'ca.pem'), join(dir, 'link.pem'));
  await assert.rejects(readDesignTrustCa(join(dir, 'link.pem')), refusal('DESIGN_TRUST_CA_INVALID'));
  await assert.rejects(readDesignTrustCa(join(dir, 'nao-existe.pem')), refusal('DESIGN_TRUST_CA_INVALID'));
  const staged = await stageDesignTrustCa(caPem);
  assert.equal(statSync(staged.path).mode & 0o777, 0o644);
  await staged.dispose();
});

test('a CA entra montada só para leitura, num alvo HTTPS', () => {
  const argv = designRunArguments({
    image: 'localhost:5000/ac-design:reconstrucao@sha256:' + 'a'.repeat(64),
    repository: '/tmp/repo',
    output: '/tmp/out',
    targetUrl: 'https://chatisp.local',
    memoryBytes: 2147483648,
    nanoCpus: 2_000_000_000,
    pidsLimit: 512,
    trustCa: '/tmp/design-ca-x/ca.pem',
  });
  assert.ok(argv.includes(`type=bind,source=/tmp/design-ca-x/ca.pem,destination=${DESIGN_TRUST_CA_MOUNT},readonly`));
  assert.ok(argv.includes(`DESIGN_TRUST_CA=${DESIGN_TRUST_CA_MOUNT}`));
  assert.ok(argv.indexOf(`DESIGN_TRUST_CA=${DESIGN_TRUST_CA_MOUNT}`) < argv.indexOf('--entrypoint'));
  assert.deepEqual(designTrustArguments('https://chatisp.local', undefined), []);
  assert.throws(() => designTrustArguments('http://chatisp.local', '/tmp/ca.pem'), refusal('DESIGN_TRUST_CA_INVALID'));
});

test('--ca exige https num host .local e não combina com --servir', () => {
  const id = '98c62210-1fa3-4760-a16c-9ba38d694d63';
  assert.equal(parseDesignArgs(['/i.json', id, '--url', 'https://chatisp.local/entrar', '--ca', '/tmp/ca.pem']).caFile, '/tmp/ca.pem');
  assert.throws(() => parseDesignArgs(['/i.json', id, '--url', 'http://chatisp.local', '--ca', '/tmp/ca.pem']), refusal('DESIGN_TRUST_CA_INVALID'));
  assert.throws(() => parseDesignArgs(['/i.json', id, '--url', 'https://localhost:8443', '--servir', '/tmp/telas', '--ca', '/tmp/ca.pem']), refusal('DESIGN_TRUST_CA_INVALID'));
  assert.throws(() => parseDesignArgs(['/i.json', id, '--url', 'https://chatisp.local', '--ca']), refusal('DESIGN_USAGE'));
});
