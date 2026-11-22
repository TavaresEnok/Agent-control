import {execFile} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, mkdtemp, open, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Refusal} from './contracts.ts';

/** CA de homologação: certificados públicos, poucos e pequenos. */
const MAX_BYTES = 64 * 1024;
const MAX_CERTS = 8;
const BLOCK = /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END CERTIFICATE-----/g;

/**
 * Confere o arquivo de --ca e devolve só os blocos de certificado, normalizados.
 * Recusa chave privada, texto solto, link simbólico, arquivo grande e certificado que não seja de CA.
 */
export async function readDesignTrustCa(path: string): Promise<string> {
  // Abre sem seguir link e lê pelo mesmo descritor que foi conferido: nada troca o arquivo no meio.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 1 || bytesRead > MAX_BYTES) throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
    return normalizeDesignTrustCa(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

export function normalizeDesignTrustCa(text: string): string {
  if (text.length > MAX_BYTES) throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
  const blocks = [...text.matchAll(BLOCK)];
  const rest = text.replace(BLOCK, '');
  if (blocks.length < 1 || blocks.length > MAX_CERTS || rest.trim() !== '') throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
  const out: string[] = [];
  for (const block of blocks) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block[0]);
    } catch {
      throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
    }
    if (!cert.ca) throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
    out.push(cert.toString().trim());
  }
  return `${out.join('\n')}\n`;
}

/** Cópia legível pelo uid da imagem. É certificado público: 0644 num diretório 0755 próprio. */
export async function stageDesignTrustCa(pem: string): Promise<{path: string; dispose(): Promise<void>}> {
  const directory = await mkdtemp(join(tmpdir(), 'design-ca-'));
  try {
    await chmod(directory, 0o755);
    const path = join(directory, 'ca.pem');
    await writeFile(path, normalizeDesignTrustCa(pem), {mode: 0o644});
    await chmod(path, 0o644);
    return {path, dispose: () => rm(directory, {recursive: true, force: true})};
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
}

/**
 * A CA de --ca vale para qualquer nome que ela assine. O que a limita à homologação é a rede:
 * design-homologation tem que ser interna, sem saída. Rede ausente ou com saída recusa.
 */
export function assertInternalDesignNetwork(
  inspect: () => Promise<string> = () => new Promise((resolve, reject) => {
    execFile('docker', ['network', 'inspect', 'design-homologation', '--format', '{{.Internal}}'], {timeout: 15_000}, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  }),
): Promise<void> {
  return inspect().then(
    out => { if (out.trim() !== 'true') throw new Refusal('DESIGN_TRUST_CA_NETWORK', 400); },
    () => { throw new Refusal('DESIGN_TRUST_CA_NETWORK', 400); },
  );
}
