import {X509Certificate} from 'node:crypto';
import {chmod, lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
  }
  if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
  const text = await readFile(path, 'utf8').catch(() => {
    throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
  });
  return normalizeDesignTrustCa(text);
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
