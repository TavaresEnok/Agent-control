import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const lock = JSON.parse(await readFile(new URL('./lock.json', import.meta.url), 'utf8'));
const registry = 'https://repo.maven.apache.org/maven2';

async function download(url, file, sha256, redirect = 'error') {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`SHA-256 ausente para ${url}`);
  const response = await fetch(url, {redirect, signal: AbortSignal.timeout(180_000)});
  if (!response.ok || !response.body) throw new Error(`Download falhou (${response.status}): ${url}`);
  const hash = createHash('sha256');
  const digest = new Transform({transform(chunk, _encoding, done) {
    hash.update(chunk);
    done(null, chunk);
  }});
  await pipeline(response.body, digest, createWriteStream(file, {flags: 'wx'}));
  if (hash.digest('hex') !== sha256) throw new Error(`SHA-256 divergente para ${url}`);
}

const arch = {x64: 'x64', arm64: 'aarch64'}[process.arch];
if (process.platform !== 'linux' || !arch) throw new Error('OpenRewrite requer Linux x64 ou arm64.');
if (!process.argv[2]) throw new Error('Informe o diretório novo para a instalação do OpenRewrite.');
const root = resolve(process.argv[2]);
const lib = join(root, 'lib');
const jdk = join(root, 'jdk');
const classes = join(root, 'classes');
const archive = join(root, 'temurin.tar.gz');
const jdkTag = encodeURIComponent(`jdk-${lock.jdk.version}`);
const jdkAsset = `OpenJDK17U-jdk_${arch}_linux_hotspot_${lock.jdk.version.replace('+', '_')}.tar.gz`;
const jdkUrl = `https://github.com/adoptium/temurin17-binaries/releases/download/${jdkTag}/${jdkAsset}`;

await mkdir(root);
try {
  await mkdir(lib);
  await mkdir(jdk);
  await mkdir(classes);
  await download(jdkUrl, archive, lock.jdk.linuxSha256[arch], 'follow');
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', jdk], {stdio: 'inherit'});
  await rm(archive);
  for (const [coordinate, hash] of Object.entries(lock.mavenSha256)) {
    const [group, artifact, version] = coordinate.split(':');
    const filename = `${artifact}-${version}.jar`;
    await download(`${registry}/${group.replaceAll('.', '/')}/${artifact}/${version}/${filename}`, join(lib, filename), hash);
  }

  execFileSync(join(jdk, 'bin', 'javac'), ['-proc:none', '-encoding', 'UTF-8', '-cp', `${lib}/*`, '-d', classes,
    fileURLToPath(new URL('./OfflineRewrite.java', import.meta.url))], {stdio: 'inherit'});
  const installed = JSON.parse(execFileSync(join(jdk, 'bin', 'java'), ['-cp', `${classes}:${lib}/*`, 'OfflineRewrite', '--version'], {encoding: 'utf8'}));
  if (installed.version !== lock.openrewriteVersion || installed.jdk !== lock.jdk.version) {
    throw new Error('Versão instalada do OpenRewrite ou do JDK diverge do lock.');
  }
  console.log(`OpenRewrite ${installed.version}, Temurin ${installed.jdk}, ${Object.keys(lock.mavenSha256).length} JARs verificados.`);
} catch (error) {
  await rm(root, {recursive: true, force: true});
  throw error;
}
