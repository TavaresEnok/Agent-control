/**
 * Confiança na CA de uma homologação HTTPS.
 *
 * Sem DESIGN_TRUST_CA, nada muda: o Chrome recusa certificado que não seja público.
 * Com ela, o Node valida a cadeia do alvo contra essa CA, com o nome do host conferido,
 * e o Chrome passa a aceitar só as chaves dessa cadeia já validada. Outro certificado,
 * ou a mesma CA servindo outro host, continua recusado.
 */
import {createHash, X509Certificate} from 'node:crypto';
import {readFileSync} from 'node:fs';
import tls from 'node:tls';

export const TRUST_CA_PATH = '/trust/ca.pem';

/** SHA-256 da SubjectPublicKeyInfo, em base64, no formato de --ignore-certificate-errors-spki-list. */
export function spkiHash(raw) {
  const key = new X509Certificate(raw).publicKey.export({type: 'spki', format: 'der'});
  return createHash('sha256').update(key).digest('base64');
}

/** Cadeia apresentada pelo servidor, do certificado final até a raiz que o Node achou. */
export function peerChain(peer) {
  const out = [];
  const seen = new Set();
  let current = peer;
  while (current && current.raw && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    out.push(current.raw);
    current = current.issuerCertificate;
  }
  return out;
}

function verifiedChain(origin, ca, timeoutMs) {
  const url = new URL(origin);
  const port = url.port === '' ? 443 : Number(url.port);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host: url.hostname, port, servername: url.hostname, ca, rejectUnauthorized: true}, () => {
      const chain = peerChain(socket.getPeerCertificate(true));
      socket.end();
      resolve(chain);
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('tempo esgotado')));
    socket.on('error', reject);
  });
}

/**
 * Flags do Chrome para o alvo. Lista vazia quando não há CA a confiar.
 * Lança DESIGN_TRUST_CA_FAILED quando a CA foi dada e a cadeia não fecha nela.
 */
export async function trustFlags(origin, env = process.env, timeoutMs = 10000) {
  const path = env.DESIGN_TRUST_CA;
  if (path === undefined || path === '') return [];
  if (path !== TRUST_CA_PATH || new URL(origin).protocol !== 'https:') throw new Error('DESIGN_TRUST_CA_FAILED');
  let ca;
  try {
    ca = readFileSync(path, 'utf8');
  } catch {
    throw new Error('DESIGN_TRUST_CA_FAILED');
  }
  return verifiedTrustFlags(origin, ca, timeoutMs);
}

/** Valida a cadeia do alvo contra a CA e devolve a flag com as chaves dessa cadeia. */
export async function verifiedTrustFlags(origin, ca, timeoutMs = 10000) {
  if (new URL(origin).protocol !== 'https:') throw new Error('DESIGN_TRUST_CA_FAILED');
  let chain;
  try {
    chain = await verifiedChain(origin, ca, timeoutMs);
  } catch {
    throw new Error('DESIGN_TRUST_CA_FAILED');
  }
  if (chain.length === 0) throw new Error('DESIGN_TRUST_CA_FAILED');
  return [`--ignore-certificate-errors-spki-list=${chain.map(spkiHash).join(',')}`];
}
