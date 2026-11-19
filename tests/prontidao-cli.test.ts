import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer as createHttpsServer, type Server as HttpsServer} from 'node:https';
import {createServer as createHttpServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {runCollector} from '../deploy/modules/prontidao/run-collector.mjs';
import {collectConfiguration, inspectConfiguration, sealConfiguration} from '../src/config-export.ts';
import {Refusal} from '../src/contracts.ts';
import {Installation} from '../src/installation.ts';
import {Ledger} from '../src/ledger.ts';
import {moduleCliFailureText, parsePersonalModuleArgs, runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {probePublishedHttpsOrigin} from '../src/prontidao-target.ts';
import {
  moduleCollectorArguments,
  readModuleReport,
  requestModuleCorrection,
  runModuleCollectorContainer,
} from '../src/verification-modules.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const databaseUrl = process.env.AC_TEST_DATABASE_URL;

type SyntheticCerts = {
  caCert: string;
  validKey: string;
  validCert: string;
  expiredKey: string;
  expiredCert: string;
  wrongHostKey: string;
  wrongHostCert: string;
  selfSignedKey: string;
  selfSignedCert: string;
};

async function createSyntheticCerts(dir: string): Promise<SyntheticCerts> {
  const caKeyPath = join(dir, 'ca-key.pem');
  const caCertPath = join(dir, 'ca-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKeyPath, '-out', caCertPath,
    '-days', '30', '-subj', '/CN=Synthetic Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ], {stdio: 'ignore'});

  const issueLeaf = (prefix: string, subj: string, san: string, opts: {startdate?: string; enddate?: string; days?: string} = {}) => {
    const keyPath = join(dir, `${prefix}-key.pem`);
    const csrPath = join(dir, `${prefix}.csr`);
    const extPath = join(dir, `${prefix}-ext.cnf`);
    const certPath = join(dir, `${prefix}-cert.pem`);
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', csrPath, '-subj', subj], {stdio: 'ignore'});
    execFileSync('sh', ['-c', `printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$1" > "$2"`, '--', san, extPath], {stdio: 'ignore'});
    const x509Args = [
      'x509', '-req', '-in', csrPath, '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial',
      '-out', certPath, '-extfile', extPath,
      ...(opts.days ? ['-days', opts.days] : []),
      ...(opts.startdate ? ['-startdate', opts.startdate] : []),
      ...(opts.enddate ? ['-enddate', opts.enddate] : []),
    ];
    if (opts.startdate || opts.enddate) {
      // OpenSSL `x509 -req` supports -days; use `openssl ca` or fake faketime? No: OpenSSL 3 supports -not_before/-not_after? Let's use -days 1 if not expired, or faketime/ca.
    }
    execFileSync('openssl', x509Args, {stdio: 'ignore'});
    return {keyPath, certPath};
  };

  const valid = issueLeaf('valid', '/CN=127.0.0.1', 'IP:127.0.0.1,DNS:localhost', {days: '30'});
  const wrong = issueLeaf('wrong', '/CN=wrong.example.invalid', 'DNS:wrong.example.invalid', {days: '30'});

  // Generate an actually expired certificate using an isolated OpenSSL CA database
  const caDbDir = join(dir, 'cadb');
  await mkdir(caDbDir, {recursive: true});
  await writeFile(join(caDbDir, 'index.txt'), '');
  await writeFile(join(caDbDir, 'serial'), '1001\n');
  const caCfg = join(dir, 'ca.cnf');
  await writeFile(caCfg, [
    '[ca]',
    'default_ca = CA_default',
    '[CA_default]',
    `database = ${join(caDbDir, 'index.txt')}`,
    `serial = ${join(caDbDir, 'serial')}`,
    `new_certs_dir = ${caDbDir}`,
    `certificate = ${caCertPath}`,
    `private_key = ${caKeyPath}`,
    'default_md = sha256',
    'policy = policy_anything',
    'copy_extensions = copy',
    '[policy_anything]',
    'commonName = optional',
    '[req]',
    'distinguished_name = dn',
    '[dn]',
  ].join('\n'));
  const expKey = join(dir, 'expired-key.pem');
  const expCsr = join(dir, 'expired.csr');
  const expCert = join(dir, 'expired-cert.pem');
  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', expKey, '-out', expCsr,
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], {stdio: 'ignore'});
  execFileSync('openssl', [
    'ca', '-batch', '-config', caCfg,
    '-startdate', '20200101000000Z',
    '-enddate', '20200201000000Z',
    '-in', expCsr, '-out', expCert,
  ], {stdio: 'ignore'});

  const selfKey = join(dir, 'self-key.pem');
  const selfCert = join(dir, 'self-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', selfKey, '-out', selfCert,
    '-days', '5', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], {stdio: 'ignore'});

  return {
    caCert: await readFile(caCertPath, 'utf8'),
    validKey: await readFile(valid.keyPath, 'utf8'),
    validCert: await readFile(valid.certPath, 'utf8'),
    expiredKey: await readFile(expKey, 'utf8'),
    expiredCert: await readFile(expCert, 'utf8'),
    wrongHostKey: await readFile(wrong.keyPath, 'utf8'),
    wrongHostCert: await readFile(wrong.certPath, 'utf8'),
    selfSignedKey: await readFile(selfKey, 'utf8'),
    selfSignedCert: await readFile(selfCert, 'utf8'),
  };
}

async function startHttps(
  opts: {key: string; cert: string; maxVersion?: 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'; ciphers?: string},
  handler: Parameters<typeof createHttpsServer>[1],
): Promise<{origin: string; close: () => Promise<void>}> {
  const server: HttpsServer = createHttpsServer(opts, handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('HTTPS_ADDR_INVALID');
  return {
    origin: `https://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function initCleanProntidaoRepo(root: string): Promise<{repo: string; commit: string}> {
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'deploy', 'caddy'), {recursive: true});
  await mkdir(join(repo, 'deploy', 'systemd'), {recursive: true});
  await mkdir(join(repo, 'deploy', 'logrotate'), {recursive: true});
  await mkdir(join(repo, 'scripts'), {recursive: true});
  await mkdir(join(repo, 'src'), {recursive: true});
  await writeFile(join(repo, 'package.json'), '{"name":"clean-svc","version":"1.0.0"}\n');
  await writeFile(join(repo, 'Dockerfile'), [
    'FROM node@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64',
    'USER 65532:65532',
    'HEALTHCHECK CMD node -e "process.exit(0)"',
    'CMD ["node", "src/server.mjs"]',
  ].join('\n'));
  await writeFile(join(repo, 'compose.yml'), [
    'services:',
    '  app:',
    '    image: node@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64',
    '    restart: unless-stopped',
    '    mem_limit: 256m',
    '    pids_limit: 64',
    '    healthcheck:',
    '      test: ["CMD", "true"]',
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
  ].join('\n'));
  await writeFile(join(repo, 'deploy', 'caddy', 'site.caddy'), [
    'app.exemplo.local {',
    '  header {',
    '    Strict-Transport-Security "max-age=31536000; includeSubDomains"',
    '    X-Content-Type-Options "nosniff"',
    '    X-Frame-Options "DENY"',
    '  }',
    '  reverse_proxy 127.0.0.1:3000',
    '}',
  ].join('\n'));
  await writeFile(join(repo, 'deploy', 'systemd', 'app.service'), '[Unit]\nOnFailure=alert@%n.service\n[Service]\nRestart=on-failure\nMemoryMax=512M\nExecStart=/usr/bin/node src/server.mjs\n');
  await writeFile(join(repo, 'scripts', 'backup.sh'), '#!/bin/sh\npg_dump -Fc -f /var/backups/app.dump "$DATABASE_URL"\nfind /var/backups -mtime +14 -delete\n');
  await writeFile(join(repo, 'scripts', 'restore-proof.sh'), '#!/bin/sh\npg_restore --exit-on-error -d "$RESTORE_DB" /var/backups/app.dump\n');
  await writeFile(join(repo, 'scripts', 'watch.sh'), '#!/bin/sh\ndf -P /\n');
  await writeFile(join(repo, 'src', 'server.mjs'), 'console.log("ok");\n');

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  await exec('git', ['init'], {cwd: repo, env});
  await exec('git', ['add', '.'], {cwd: repo, env});
  await exec('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'], {cwd: repo, env});
  const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo, env})).stdout.trim();
  return {repo, commit};
}

function hostCollectorStub(spec: {repoPath: string; passiveTlsEvidence?: unknown}) {
  return runCollector({
    repoRoot: spec.repoPath,
    ...(spec.passiveTlsEvidence !== undefined ? {passiveTlsEvidence: spec.passiveTlsEvidence} : {}),
    runBin(bin, args) {
      if (args[0] === 'version') return {status: 0, stdout: '8.30.1\n', stderr: ''};
      if (args[0] === '--version') {
        if (bin === 'hadolint') return {status: 0, stdout: 'Haskell Dockerfile Linter 2.15.1\n', stderr: ''};
        if (bin === 'trivy') return {status: 0, stdout: 'Version: 0.76.2\n', stderr: ''};
        if (bin === 'testssl.sh') return {status: 0, stdout: 'testssl.sh version 3.2.5\n', stderr: ''};
      }
      if (bin === 'gitleaks') {
        const reportPath = args[args.indexOf('--report-path') + 1]!;
        writeFileSync(reportPath, '[]\n');
        return {status: 0, stdout: '', stderr: ''};
      }
      if (bin === 'hadolint') return {status: 0, stdout: '[]', stderr: ''};
      if (bin === 'trivy') {
        const outPath = args[args.indexOf('--output') + 1]!;
        writeFileSync(outPath, '{"Results":[]}\n');
        return {status: 0, stdout: '', stderr: ''};
      }
      return {status: 0, stdout: '', stderr: ''};
    },
  });
}

test('Installation, parsePersonalModuleArgs e moduleCollectorArguments validam origens HTTPS e montagem isolada', async () => {
  const projectId = randomUUID();
  const baseInstall = {
    schemaVersion: 1 as const,
    mode: 'administration-only' as const,
    activation: 'personal' as const,
    databaseUrl: 'postgresql://postgres:synthetic@localhost/db',
    dataDirectory: '/tmp/ac-data-c6',
    project: {
      id: projectId,
      label: 'App',
      repo: '/tmp/ac-repo-c6',
      owner: 'owner@example.com',
      publishedOrigin: 'https://app.example.com/',
    },
    publishedOrigins: ['https://status.example.com:8443'],
    http: {listen: '127.0.0.1' as const, port: 18425, publicOrigin: 'http://127.0.0.1:18425'},
    happier: {
      upstreamOrigin: 'http://127.0.0.1:18421',
      webOrigin: 'http://127.0.0.1:18420',
      publicServerOrigin: 'http://127.0.0.1:18421',
    },
  };
  const parsed = Installation.parse(baseInstall);
  assert.equal(parsed.project.publishedOrigin, 'https://app.example.com');
  assert.deepEqual(parsed.publishedOrigins, ['https://status.example.com:8443']);

  assert.throws(() => Installation.parse({
    ...baseInstall,
    project: {...baseInstall.project, publishedOrigin: 'http://app.example.com'},
  }));
  assert.throws(() => Installation.parse({
    ...baseInstall,
    project: {...baseInstall.project, publishedOrigin: 'https://user:pass@app.example.com'},
  }));
  assert.throws(() => Installation.parse({
    ...baseInstall,
    project: {...baseInstall.project, publishedOrigin: 'https://app.example.com/admin?x=1'},
  }));

  const cliRun = parsePersonalModuleArgs('prontidao', ['/tmp/inst.json', projectId, '--origem', 'https://app.example.com']);
  assert.equal(cliRun.kind, 'run');
  if (cliRun.kind === 'run') assert.equal(cliRun.origin, 'https://app.example.com');

  const cliEq = parsePersonalModuleArgs('prontidao', ['/tmp/inst.json', projectId, '--origem=https://app.example.com']);
  assert.equal(cliEq.kind, 'run');
  if (cliEq.kind === 'run') assert.equal(cliEq.origin, 'https://app.example.com');

  assert.throws(
    () => parsePersonalModuleArgs('qa', ['/tmp/inst.json', projectId, '--origem', 'https://app.example.com']),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_USAGE',
  );
  assert.throws(
    () => parsePersonalModuleArgs('prontidao', ['/tmp/inst.json', projectId, '--origem', 'https://app.example.com', '--descartar', randomUUID()]),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_USAGE',
  );

  assert.match(moduleCliFailureText(new Refusal('PRONTIDAO_ORIGIN_UNAUTHORIZED', 403), 'prontidao'), /não está declarada/);
  assert.match(moduleCliFailureText(new Refusal('VERIFY_USAGE', 400), 'prontidao'), /--origem/);

  const pinned = `sha256:${'ab'.repeat(32)}`;
  const args = moduleCollectorArguments({
    image: pinned,
    repository: '/tmp/ac-snap',
    evidenceFile: '/tmp/ac-ev/evidence.json',
  });
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  const mounts = args.filter((_item, idx) => args[idx - 1] === '--mount');
  assert.deepEqual(mounts, [
    'type=bind,src=/tmp/ac-snap,dst=/repo,readonly',
    'type=bind,src=/tmp/ac-ev/evidence.json,dst=/run/prontidao-evidence.json,readonly',
  ]);
  assert.throws(
    () => moduleCollectorArguments({image: pinned, repository: '/tmp/ac-snap', evidenceFile: '/tmp/ac-snap/ev.json'}),
    (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN',
  );

  // Valida runModuleCollectorContainer montando evidence.json temporário legível por 65532 e limpando no fim
  const repoRoot = await mkdtemp(join(tmpdir(), 'ac-c6-cont-'));
  let seenEvidencePath = '';
  try {
    const {repo, commit} = await initCleanProntidaoRepo(repoRoot);
    const ev = {
      schemaVersion: 1 as const,
      collectedBy: 'agent-control-prontidao-adapter' as const,
      collectedAt: '2026-11-19T00:00:00.000Z',
      targets: [{
        origin: 'https://app.example.com',
        status: 'ok' as const,
        httpStatus: 200,
        tlsProtocol: 'TLSv1.3',
        cipher: 'TLS_AES_256_GCM_SHA384',
        tlsAuthorized: true,
        tlsErrorCode: null,
        tlsErrorMessage: null,
        errorCode: null,
        errorMessage: null,
        certificate: {subject: 'CN=app.example.com', issuer: 'CN=CA', validFrom: '2026-01-01', validTo: '2027-01-01', daysRemaining: 60, subjectAltName: 'DNS:app.example.com'},
        headers: {},
        redirectTargetOrigin: null,
        redirectCrossOrigin: false,
        redirectDowngradeHttp: false,
        bytesRead: 0,
        truncated: false,
        durationMs: 10,
      }],
    };
    const contOut = await runModuleCollectorContainer({
      image: pinned,
      repoPath: repo,
      commit,
      passiveTlsEvidence: ev,
      async executeProcess(runArgs) {
        assert.equal(runArgs[runArgs.indexOf('--network') + 1], 'none');
        const mountArgs = runArgs.filter((_item, idx) => runArgs[idx - 1] === '--mount');
        const repoMount = mountArgs.find(m => m.includes('dst=/repo,readonly'))!;
        const evMount = mountArgs.find(m => m.includes('dst=/run/prontidao-evidence.json,readonly'))!;
        const snapPath = repoMount.slice('type=bind,src='.length).split(',')[0]!;
        seenEvidencePath = evMount.slice('type=bind,src='.length).split(',')[0]!;
        assert.equal((await stat(seenEvidencePath)).mode & 0o777, 0o644);
        const collectorRes = runCollector({
          repoRoot: snapPath,
          evidenceFile: seenEvidencePath,
          runBin(bin, binArgs) {
            if (binArgs[0] === 'version') return {status: 0, stdout: '8.30.1\n', stderr: ''};
            if (binArgs[0] === '--version') return {status: 0, stdout: '2.15.1\n', stderr: ''};
            if (bin === 'gitleaks') {
              writeFileSync(binArgs[binArgs.indexOf('--report-path') + 1]!, '[]\n');
              return {status: 0, stdout: '', stderr: ''};
            }
            if (bin === 'hadolint') return {status: 0, stdout: '[]', stderr: ''};
            if (bin === 'trivy') {
              writeFileSync(binArgs[binArgs.indexOf('--output') + 1]!, '{"Results":[]}\n');
              return {status: 0, stdout: '', stderr: ''};
            }
            return {status: 0, stdout: '', stderr: ''};
          },
        });
        return {code: 0, stdout: Buffer.from(`${JSON.stringify(collectorRes)}\n`, 'utf8'), stderr: ''};
      },
    });
    assert.equal(contOut.output.coverage.find(c => c.tool === 'prontidao-tls-passivo')?.status, 'ok');
    assert.equal(contOut.output.findings.some(f => f.rule === 'PRONTIDAO-HSTS-AUSENTE'), true);
    await assert.rejects(() => stat(seenEvidencePath));
  } finally {
    await rm(repoRoot, {recursive: true, force: true});
  }
});

test('config-export projeta publishedOrigin/publishedOrigins como Binding endpoint sem vazar URL', async () => {
  if (!databaseUrl) throw new Error('ISOLATED_DATABASE_REQUIRED');
  const folder = await mkdtemp(join(tmpdir(), 'ac-c6-export-'));
  const database = await isolatedDatabase(databaseUrl, 'c6export');
  const db = new Ledger(database.url);
  await db.migrate();
  const project = randomUUID();
  const owner = `owner-${randomUUID()}`;
  const key = randomBytes(32);
  try {
    const config = Installation.parse({
      schemaVersion: 1,
      mode: 'administration-only',
      databaseUrl: database.url,
      projectRoots: [],
      dataDirectory: folder,
      project: {
        id: project,
        label: 'ExportProj',
        repo: '/tmp/repo-c6-export',
        owner,
        publishedOrigin: 'https://seguro.exemplo.internal',
        publishedOrigins: ['https://painel.exemplo.internal:8443'],
      },
      publishedOrigins: ['https://global.exemplo.internal'],
      http: {listen: '127.0.0.1', port: 18426, publicOrigin: 'http://127.0.0.1:18426'},
      happier: {upstreamOrigin: 'http://127.0.0.1:18421', webOrigin: 'http://127.0.0.1:18420', publicServerOrigin: 'http://127.0.0.1:18421'},
    });
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'ExportProj']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);

    const dto = await collectConfiguration(db, owner, project, config);
    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes('seguro.exemplo.internal'), false);
    assert.equal(serialized.includes('painel.exemplo.internal'), false);
    assert.equal(serialized.includes('global.exemplo.internal'), false);
    const sealed = sealConfiguration(dto, key);
    const decoded = inspectConfiguration(sealed, key);
    assert.deepEqual(decoded, dto);
  } finally {
    key.fill(0);
    await db.close();
    await database.close();
    await rm(folder, {recursive: true, force: true});
  }
});

test('fluxo completo da CLI personal:prontidao com servidor HTTPS sintético (TLS, cabeçalhos, redirecionamento, limites, origem não autorizada e modo offline)', {timeout: 90_000}, async () => {
  if (!databaseUrl) throw new Error('ISOLATED_DATABASE_REQUIRED');
  const root = await mkdtemp(join(tmpdir(), 'ac-prontidao-cli-'));
  const database = await isolatedDatabase(databaseUrl, 'prontidao_cli');
  const db = new Ledger(database.url);
  await db.migrate();

  const certDir = join(root, 'certs');
  await mkdir(certDir, {recursive: true});
  const certs = await createSyntheticCerts(certDir);

  const projectId = randomUUID();
  const principal = 'owner-prontidao@example.com';
  const dataDirectory = join(root, 'data');
  await mkdir(dataDirectory, {mode: 0o700});
  const {repo} = await initCleanProntidaoRepo(root);

  await db.pool.query('INSERT INTO ac_projects VALUES ($1, $2)', [projectId, 'ProjetoProntidao']);
  await db.pool.query('INSERT INTO ac_project_repositories (project_id, repo) VALUES ($1, $2)', [projectId, repo]);
  await db.pool.query("INSERT INTO ac_memberships VALUES ($1, $2, 'owner')", [projectId, principal]);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await db.createContext(principal, projectId, randomUUID());

  const writeInst = async (opts: {publishedOrigin?: string; publishedOrigins?: string[]}) => {
    const file = join(root, `installation-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      mode: 'administration-only',
      activation: 'personal',
      databaseUrl: database.url,
      dataDirectory,
      project: {
        id: projectId,
        label: 'ProjetoProntidao',
        repo,
        owner: principal,
        ...(opts.publishedOrigin ? {publishedOrigin: opts.publishedOrigin} : {}),
        ...(opts.publishedOrigins ? {publishedOrigins: opts.publishedOrigins} : {}),
      },
      http: {listen: '127.0.0.1', port: 18427, publicOrigin: 'http://127.0.0.1:18427'},
      happier: {
        upstreamOrigin: 'http://127.0.0.1:18421',
        webOrigin: 'http://127.0.0.1:18420',
        publicServerOrigin: 'http://127.0.0.1:18421',
      },
    }), {mode: 0o600});
    await chmod(file, 0o600);
    return file;
  };

  try {
    // 1. Servidor HTTPS limpo com cabeçalhos fortes e resposta grande (testa limite de bytes e ausência de cookies/disfarce)
    const seenRequests: {method?: string; url?: string; headers: Record<string, unknown>}[] = [];
    const cleanServer = await startHttps({key: certs.validKey, cert: certs.validCert}, (req, res) => {
      seenRequests.push({method: req.method, url: req.url, headers: {...req.headers}});
      res.writeHead(200, {
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Set-Cookie': 'session=secret-do-not-leak; HttpOnly; Secure',
        'Content-Type': 'text/plain',
      });
      res.end('A'.repeat(128 * 1024));
    });

    try {
      const instClean = await writeInst({publishedOrigin: cleanServer.origin});
      const [cleanRunId] = await runPersonalModuleCli('prontidao', [instClean, projectId], {
        prontidaoProbeOptions: {ca: certs.caCert, maxResponseBytes: 4096, timeoutMs: 5000},
        runCollector: async spec => hostCollectorStub(spec),
      });
      assert.ok(cleanRunId);
      assert.equal(seenRequests.length, 1);
      assert.equal(seenRequests[0]?.method, 'GET');
      assert.equal(seenRequests[0]?.url, '/');
      assert.equal(seenRequests[0]?.headers['cookie'], undefined);
      assert.equal(seenRequests[0]?.headers['authorization'], undefined);
      assert.equal(seenRequests[0]?.headers['user-agent'], 'agent-control-prontidao/1.0');

      const cleanReport = await readModuleReport(dataDirectory, projectId, cleanRunId, 'prontidao');
      assert.equal(cleanReport.achados.length, 0);
      assert.equal(cleanReport.toolCoverage.find(t => t.tool === 'prontidao-tls-passivo')?.status, 'ok');
      assert.match(cleanReport.toolCoverage.find(t => t.tool === 'prontidao-tls-passivo')?.detail ?? '', /bytes=4096/);
      assert.equal(cleanReport.toolCoverage.find(t => t.tool === 'testssl.sh')?.status, 'skipped');
      assert.equal(cleanReport.readmeMarkdown.includes('secret-do-not-leak'), false);
      assert.match(cleanReport.readmeMarkdown, /O que não foi possível verificar/);
      assert.match(cleanReport.readmeMarkdown, /prontidao:operacional:restauracao/);

      // Origem não autorizada deve ser recusada antes de qualquer requisição
      let rogueHits = 0;
      const rogueServer = await startHttps({key: certs.validKey, cert: certs.validCert}, (_req, res) => {
        rogueHits += 1;
        res.end('rogue');
      });
      try {
        await assert.rejects(
          () => runPersonalModuleCli('prontidao', [instClean, projectId, '--origem', rogueServer.origin], {
            prontidaoProbeOptions: {ca: certs.caCert},
            runCollector: async spec => hostCollectorStub(spec),
          }),
          (err: unknown) => err instanceof Refusal && err.code === 'PRONTIDAO_ORIGIN_UNAUTHORIZED' && err.status === 403,
        );
        await assert.rejects(
          () => runPersonalModuleCli('prontidao', [instClean, projectId, '--origem', 'http://127.0.0.1:8080'], {
            runCollector: async spec => hostCollectorStub(spec),
          }),
          (err: unknown) => err instanceof Refusal && err.code === 'PRONTIDAO_ORIGIN_INVALID',
        );
        assert.equal(rogueHits, 0);
      } finally {
        await rogueServer.close();
      }
    } finally {
      await cleanServer.close();
    }

    // 2. Servidor HTTPS sem cabeçalhos de segurança + redirecionamento para HTTP (não seguido!)
    let redirectTargetHits = 0;
    const redirectTarget = createHttpServer((_req, res) => {
      redirectTargetHits += 1;
      res.end('should never be visited');
    });
    await new Promise<void>(resolve => redirectTarget.listen(0, '127.0.0.1', resolve));
    const redirectTargetAddr = redirectTarget.address();
    assert.ok(redirectTargetAddr && typeof redirectTargetAddr !== 'string');
    const redirectHttpOrigin = `http://127.0.0.1:${redirectTargetAddr.port}`;

    const weakHeadersServer = await startHttps({key: certs.validKey, cert: certs.validCert}, (_req, res) => {
      res.writeHead(302, {Location: `${redirectHttpOrigin}/login`});
      res.end();
    });
    try {
      const instHeaders = await writeInst({publishedOrigins: [weakHeadersServer.origin]});
      const [hdrRunId] = await runPersonalModuleCli('prontidao', [instHeaders, projectId, '--origem', weakHeadersServer.origin], {
        prontidaoProbeOptions: {ca: certs.caCert, timeoutMs: 5000},
        runCollector: async spec => hostCollectorStub(spec),
      });
      assert.equal(redirectTargetHits, 0, 'redirecionamento para outro destino nunca deve ser seguido');
      const hdrReport = await readModuleReport(dataDirectory, projectId, hdrRunId!, 'prontidao');
      const hdrRules = new Set(hdrReport.achados.map(a => a.sources[1]));
      assert.equal(hdrRules.has('PRONTIDAO-REDIR-HTTP'), true);
      assert.equal(hdrRules.has('PRONTIDAO-HSTS-AUSENTE'), true);
      assert.equal(hdrRules.has('PRONTIDAO-NOSNIFF-AUSENTE'), true);
      assert.equal(hdrRules.has('PRONTIDAO-FRAME-AUSENTE'), true);

      // Converte achado em tarefa normalmente pelo fluxo do produto
      const prontidaoAuth = await db.acquire(principal, (await db.ensureExamContext(principal, projectId, 'prontidao')).contextId, randomUUID(), 'test-fix', 60);
      try {
        const remediation = await requestModuleCorrection(db, principal, prontidaoAuth, {
          module: 'prontidao',
          runId: hdrRunId!,
          achadoIds: ['ACH-001'],
          dataDirectory,
          projectId,
          repoPath: repo,
        });
        assert.deepEqual(remediation.writePaths, ['deploy/caddy/site.caddy']);
      } finally {
        await db.releaseLease(prontidaoAuth);
      }
    } finally {
      await weakHeadersServer.close();
      await new Promise<void>(resolve => redirectTarget.close(() => resolve()));
    }

    // 3. Falhas de TLS (autoassinado não confiável, expirado, hostname divergente e protocolo legado TLS 1.1)
    const selfServer = await startHttps({key: certs.selfSignedKey, cert: certs.selfSignedCert}, (_q, r) => r.end('ok'));
    const expServer = await startHttps({key: certs.expiredKey, cert: certs.expiredCert}, (_q, r) => r.end('ok'));
    const wrongServer = await startHttps({key: certs.wrongHostKey, cert: certs.wrongHostCert}, (_q, r) => r.end('ok'));
    const tls11Server = await startHttps({key: certs.validKey, cert: certs.validCert, maxVersion: 'TLSv1.1', ciphers: 'ALL:@SECLEVEL=0'}, (_q, r) => r.end('ok'));
    try {
      const tlsCases: {origin: string; expectedRule: string; ca?: string}[] = [
        {origin: selfServer.origin, expectedRule: 'PRONTIDAO-TLS-FALHA', ca: certs.caCert},
        {origin: expServer.origin, expectedRule: 'PRONTIDAO-CERT-EXPIRADO', ca: certs.caCert},
        {origin: wrongServer.origin, expectedRule: 'PRONTIDAO-CERT-DOMINIO', ca: certs.caCert},
        {origin: tls11Server.origin, expectedRule: 'PRONTIDAO-TLS-FRACO', ca: certs.caCert},
      ];
      for (const tc of tlsCases) {
        const instTls = await writeInst({publishedOrigin: tc.origin});
        const [tlsRunId] = await runPersonalModuleCli('prontidao', [instTls, projectId], {
          prontidaoProbeOptions: {ca: tc.ca, timeoutMs: 5000},
          runCollector: async spec => hostCollectorStub(spec),
        });
        const rep = await readModuleReport(dataDirectory, projectId, tlsRunId!, 'prontidao');
        assert.equal(rep.toolCoverage.find(t => t.tool === 'prontidao-tls-passivo')?.status, 'ok');
        assert.equal(
          rep.achados.some(a => a.severity === 'alta' && a.sources[1] === tc.expectedRule),
          true,
          `regra TLS esperada ${tc.expectedRule} para ${tc.origin}, obtido: ${JSON.stringify(rep.achados.map(a => a.sources))}`,
        );
      }
    } finally {
      await selfServer.close();
      await expServer.close();
      await wrongServer.close();
      await tls11Server.close();
    }

    // 4. Timeout / servidor indisponível -> falha registrada na cobertura, relatório gravado e CLI sai com VERIFY_TOOLS_FAILED
    const slowServer = await startHttps({key: certs.validKey, cert: certs.validCert}, (_req, _res) => {
      // mantém conexão aberta sem responder para testar tempo limite
    });
    try {
      const instSlow = await writeInst({publishedOrigin: slowServer.origin});
      await assert.rejects(
        () => runPersonalModuleCli('prontidao', [instSlow, projectId], {
          prontidaoProbeOptions: {ca: certs.caCert, timeoutMs: 250},
          runCollector: async spec => hostCollectorStub(spec),
        }),
        (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_TOOLS_FAILED',
      );
      const slowProbe = await probePublishedHttpsOrigin(slowServer.origin, {ca: certs.caCert, timeoutMs: 250});
      assert.equal(slowProbe.status, 'failed');
      assert.equal(slowProbe.errorCode, 'ETIMEDOUT');
    } finally {
      await slowServer.close();
    }

    // 5. Modo offline preservado (sem origem declarada na instalação/projeto) e recusa de --origem quando não declarada
    const instOffline = await writeInst({});
    await assert.rejects(
      () => runPersonalModuleCli('prontidao', [instOffline, projectId, '--origem', 'https://127.0.0.1:4443'], {
        runCollector: async spec => hostCollectorStub(spec),
      }),
      (err: unknown) => err instanceof Refusal && err.code === 'PRONTIDAO_ORIGIN_UNAUTHORIZED',
    );
    const [offlineRunId] = await runPersonalModuleCli('prontidao', [instOffline, projectId], {
      runCollector: async spec => {
        assert.equal(spec.passiveTlsEvidence, undefined);
        return hostCollectorStub(spec);
      },
    });
    const offlineReport = await readModuleReport(dataDirectory, projectId, offlineRunId!, 'prontidao');
    assert.equal(offlineReport.toolCoverage.find(t => t.tool === 'prontidao-tls-passivo')?.status, 'skipped');
    assert.equal(offlineReport.toolCoverage.find(t => t.tool === 'testssl.sh')?.status, 'skipped');
    assert.equal(offlineReport.toolCoverage.find(t => t.tool === 'prontidao:operacional:restauracao')?.status, 'skipped');
    assert.equal(offlineReport.toolCoverage.find(t => t.tool === 'prontidao:operacional:alertas')?.status, 'skipped');
    assert.equal(offlineReport.toolCoverage.find(t => t.tool === 'prontidao:operacional:disponibilidade')?.status, 'skipped');
  } finally {
    await db.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});
