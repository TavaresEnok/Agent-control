/**
 * Confiança na CA de uma homologação HTTPS.
 *
 * Sem DESIGN_TRUST_CA, nada muda: o Chrome recusa certificado que não seja público.
 * Com ela, a CA entra no banco NSS do usuário do contêiner ($HOME/.pki/nssdb), que o Chrome
 * do exame, do pa11y e do Lighthouse consultam. A validação continua a normal: cadeia
 * assinada, nome do host e validade. Nenhuma flag do Chrome ignora erro de certificado.
 * Antes, o Node confere que o alvo fecha nessa CA, para a falha ter causa clara.
 */
import {spawnSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import tls from 'node:tls';

export const TRUST_CA_PATH = '/trust/ca.pem';
const CERTUTIL = '/usr/bin/certutil';
const BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function handshake(origin, ca, timeoutMs) {
  const url = new URL(origin);
  const port = url.port === '' ? 443 : Number(url.port);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host: url.hostname, port, servername: url.hostname, ca, rejectUnauthorized: true}, () => {
      socket.end();
      resolve();
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('tempo esgotado')));
    socket.on('error', reject);
  });
}

/** O alvo HTTPS fecha na CA dada, com o nome do host conferido. */
export async function verifyTargetAgainstCa(origin, ca, timeoutMs = 10000) {
  if (new URL(origin).protocol !== 'https:') throw new Error('DESIGN_TRUST_CA_FAILED');
  try {
    await handshake(origin, ca, timeoutMs);
  } catch {
    throw new Error('DESIGN_TRUST_CA_FAILED');
  }
}

/** Cria o banco NSS em `home` e importa cada certificado de CA como âncora só para TLS. */
export function installNssTrust(home, ca, run = spawnSync) {
  const blocks = ca.match(BLOCK) ?? [];
  if (blocks.length === 0) throw new Error('DESIGN_TRUST_CA_FAILED');
  for (const block of blocks) {
    if (!new X509Certificate(block).ca) throw new Error('DESIGN_TRUST_CA_FAILED');
  }
  const db = join(home, '.pki', 'nssdb');
  mkdirSync(db, {recursive: true, mode: 0o700});
  const certutil = args => {
    const result = run(CERTUTIL, args, {encoding: 'utf8', timeout: 30000, shell: false});
    if (result.status !== 0) throw new Error('DESIGN_TRUST_CA_FAILED');
  };
  certutil(['-d', `sql:${db}`, '-N', '--empty-password']);
  blocks.forEach((block, index) => {
    const file = join(db, `homologacao-${index}.pem`);
    writeFileSync(file, `${block}\n`, {mode: 0o600});
    certutil(['-d', `sql:${db}`, '-A', '-t', 'C,,', '-n', `homologacao-${index}`, '-i', file]);
  });
}

/**
 * Prepara a confiança do Chrome para o alvo. Sem CA, não faz nada.
 * Lança DESIGN_TRUST_CA_FAILED quando a CA foi dada e o alvo não fecha nela.
 */
export async function prepareTrust(origin, env = process.env, timeoutMs = 10000) {
  const path = env.DESIGN_TRUST_CA;
  if (path === undefined || path === '') return;
  const home = env.HOME;
  if (path !== TRUST_CA_PATH || typeof home !== 'string' || !home.startsWith('/tmp')) throw new Error('DESIGN_TRUST_CA_FAILED');
  let ca;
  try {
    ca = readFileSync(path, 'utf8');
  } catch {
    throw new Error('DESIGN_TRUST_CA_FAILED');
  }
  await verifyTargetAgainstCa(origin, ca, timeoutMs);
  installNssTrust(home, ca);
}
