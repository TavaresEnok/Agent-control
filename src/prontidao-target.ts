import {request as httpsRequest, type RequestOptions} from 'node:https';
import type {TLSSocket} from 'node:tls';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import type {Installation} from './installation.ts';

export const PRONTIDAO_USER_AGENT = 'agent-control-prontidao/1.0';
export const DEFAULT_PRONTIDAO_TIMEOUT_MS = 10_000;
export const DEFAULT_PRONTIDAO_MAX_BYTES = 65_536;
export const MAX_PRONTIDAO_ORIGINS = 16;
const MAX_DECLARED_ORIGINS = 49; // publishedOrigin + 16 do projeto + 32 da instalação

const ALLOWED_SECURITY_HEADERS = new Set([
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'content-security-policy',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cache-control',
]);

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
  'ERR_SSL_INVALID_VERSION',
]);

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export const PassiveTlsCertificate = z.object({
  subject: z.string().max(400).nullable(),
  issuer: z.string().max(400).nullable(),
  validFrom: z.string().max(80).nullable(),
  validTo: z.string().max(80).nullable(),
  daysRemaining: z.number().int().min(-100_000).max(100_000).nullable(),
  subjectAltName: z.string().max(1000).nullable(),
}).strict();
export type PassiveTlsCertificate = z.infer<typeof PassiveTlsCertificate>;

export const PassiveTlsTargetObservation = z.object({
  origin: z.string().min(8).max(2048),
  status: z.enum(['ok', 'tls_error', 'failed']),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  tlsProtocol: z.string().max(40).nullable(),
  cipher: z.string().max(120).nullable(),
  tlsAuthorized: z.boolean(),
  tlsErrorCode: z.string().max(120).nullable(),
  tlsErrorMessage: z.string().max(500).nullable(),
  errorCode: z.string().max(120).nullable(),
  errorMessage: z.string().max(500).nullable(),
  certificate: PassiveTlsCertificate.nullable(),
  headers: z.record(z.string().max(80), z.string().max(1000)),
  redirectTargetOrigin: z.string().max(2048).nullable(),
  redirectCrossOrigin: z.boolean(),
  redirectDowngradeHttp: z.boolean(),
  bytesRead: z.number().int().nonnegative(),
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type PassiveTlsTargetObservation = z.infer<typeof PassiveTlsTargetObservation>;

export const ProntidaoPassiveEvidence = z.object({
  schemaVersion: z.literal(1),
  collectedBy: z.literal('agent-control-prontidao-adapter'),
  collectedAt: z.string().min(1).max(60),
  targets: z.array(PassiveTlsTargetObservation).min(1).max(MAX_PRONTIDAO_ORIGINS),
  unmeasuredOrigins: z.array(z.string().min(8).max(2048)).max(MAX_DECLARED_ORIGINS - MAX_PRONTIDAO_ORIGINS).optional(),
}).strict();
export type ProntidaoPassiveEvidence = z.infer<typeof ProntidaoPassiveEvidence>;

export type PassiveHttpsProbeOptions = {
  timeoutMs?: number;
  maxResponseBytes?: number;
  ca?: string | Buffer | readonly (string | Buffer)[];
  now?: () => Date;
  signal?: AbortSignal;
};

function cleanSingleLine(value: unknown, maxLen: number): string {
  return String(value ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function formatX509Name(name: unknown): string | null {
  if (!name || typeof name !== 'object') return null;
  const parts = Object.entries(name as Record<string, unknown>)
    .filter(([, val]) => val !== undefined && val !== null)
    .map(([key, val]) => `${key}=${Array.isArray(val) ? val.join(',') : String(val)}`);
  if (parts.length === 0) return null;
  return cleanSingleLine(parts.join(', '), 400);
}

function isTlsFailure(code: string, message: string): boolean {
  if (TLS_ERROR_CODES.has(code)) return true;
  if (code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_') || code.startsWith('CERT_')) return true;
  return code === 'EPROTO' && /ssl|tls|handshake|protocol version|certificate/i.test(message);
}

/** Validates an explicit HTTPS origin without credentials, path, query, or fragment. */
export function parseAuthorizedHttpsOrigin(raw: string): string {
  if (typeof raw !== 'string') throw new Refusal('PRONTIDAO_ORIGIN_INVALID', 400);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(trimmed) || trimmed.toLowerCase().includes('.sock')) {
    throw new Refusal('PRONTIDAO_ORIGIN_INVALID', 400);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Refusal('PRONTIDAO_ORIGIN_INVALID', 400);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Refusal('PRONTIDAO_ORIGIN_INVALID', 400);
  }
  return url.origin;
}

/** Lists the HTTPS origins explicitly declared and authorized by the owner on the project/installation. */
export function resolveProjectAuthorizedOrigins(config: Installation, projectId: string): string[] {
  const project = [config.project, ...config.projects].find(item => item.id === projectId);
  if (!project) throw new Refusal('NOT_FOUND', 404);
  const rawCandidates = [
    ...(project.publishedOrigin ? [project.publishedOrigin] : []),
    ...(project.publishedOrigins ?? []),
    ...(config.publishedOrigins ?? []),
  ];
  const unique: string[] = [];
  for (const item of rawCandidates) {
    const normalized = parseAuthorizedHttpsOrigin(item);
    if (!unique.includes(normalized)) unique.push(normalized);
  }
  return unique;
}

/** Authorizes either the requested `--origem` (against declared origins) or the project's declared HTTPS origins. */
export function authorizeProjectHttpsOrigin(
  config: Installation,
  projectId: string,
  requestedOrigin?: string,
): string[] {
  const authorized = resolveProjectAuthorizedOrigins(config, projectId);
  if (requestedOrigin !== undefined) {
    const normalized = parseAuthorizedHttpsOrigin(requestedOrigin);
    if (!authorized.includes(normalized)) {
      throw new Refusal('PRONTIDAO_ORIGIN_UNAUTHORIZED', 403);
    }
    return [normalized];
  }
  return authorized;
}

function sanitizeHeaders(rawHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = key.toLowerCase();
    if (!ALLOWED_SECURITY_HEADERS.has(lower) || value === undefined) continue;
    const joined = Array.isArray(value) ? value.join(', ') : value;
    const cleaned = joined.length > 1000 ? '[valor excede o limite]' : joined.trim();
    if (cleaned.length > 0) out[lower] = cleaned;
  }
  return out;
}

function inspectRedirect(origin: string, statusCode: number | undefined, locationHeader: string | string[] | undefined): {
  redirectTargetOrigin: string | null;
  redirectCrossOrigin: boolean;
  redirectDowngradeHttp: boolean;
} {
  if (!statusCode || statusCode < 300 || statusCode >= 400 || !locationHeader) {
    return {redirectTargetOrigin: null, redirectCrossOrigin: false, redirectDowngradeHttp: false};
  }
  const raw = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
  if (!raw) return {redirectTargetOrigin: null, redirectCrossOrigin: false, redirectDowngradeHttp: false};
  try {
    const dest = new URL(raw.trim(), origin);
    const redirectDowngradeHttp = dest.protocol === 'http:';
    const redirectCrossOrigin = dest.origin !== origin;
    return {
      redirectTargetOrigin: cleanSingleLine(dest.origin, 2048),
      redirectCrossOrigin,
      redirectDowngradeHttp,
    };
  } catch {
    return {redirectTargetOrigin: null, redirectCrossOrigin: false, redirectDowngradeHttp: false};
  }
}

/**
 * Performs a single bounded passive HTTPS GET / request without cookies, credentials,
 * client disguise, vulnerability scanning, or redirect following.
 */
export function probePublishedHttpsOrigin(
  originInput: string,
  options?: PassiveHttpsProbeOptions,
): Promise<PassiveTlsTargetObservation> {
  const origin = parseAuthorizedHttpsOrigin(originInput);
  const url = new URL(origin);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PRONTIDAO_TIMEOUT_MS;
  const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_PRONTIDAO_MAX_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 30_000) {
    throw new Refusal('VERIFY_LIMITS_INVALID', 400);
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 262_144) {
    throw new Refusal('VERIFY_LIMITS_INVALID', 400);
  }
  const nowFn = options?.now ?? (() => new Date());
  const startedAt = Date.now();
  const signal = options?.signal;
  signal?.throwIfAborted();

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: ReturnType<typeof httpsRequest> | undefined;

    const settle = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      if (settled) return;
      settle();
      req?.destroy();
      rejectPromise(signal?.reason);
    };
    const done = (obs: PassiveTlsTargetObservation) => {
      if (settled) return;
      settle();
      const validated = PassiveTlsTargetObservation.safeParse(obs);
      if (validated.success) resolvePromise(validated.data);
      else rejectPromise(new Refusal('VERIFY_COLLECTOR_INVALID'));
    };
    const fail = (errorCode: string, errorMessage: string) => {
      done({
        origin,
        status: 'failed',
        httpStatus: null,
        tlsProtocol: null,
        cipher: null,
        tlsAuthorized: false,
        tlsErrorCode: null,
        tlsErrorMessage: null,
        errorCode,
        errorMessage,
        certificate: null,
        headers: {},
        redirectTargetOrigin: null,
        redirectCrossOrigin: false,
        redirectDowngradeHttp: false,
        bytesRead: 0,
        truncated: false,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    };

    const reqOptions: RequestOptions = {
      protocol: 'https:',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 443,
      method: 'GET',
      path: '/',
      agent: false,
      rejectUnauthorized: true,
      headers: {
        'User-Agent': PRONTIDAO_USER_AGENT,
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        Connection: 'close',
      },
      ...(options?.ca !== undefined ? {ca: options.ca as string | Buffer | (string | Buffer)[]} : {}),
    };

    req = httpsRequest(reqOptions, res => {
      const tlsSocket = res.socket as TLSSocket | null;
      const protocol = tlsSocket && typeof tlsSocket.getProtocol === 'function' ? tlsSocket.getProtocol() : null;
      const cipherInfo = tlsSocket && typeof tlsSocket.getCipher === 'function' ? tlsSocket.getCipher() : null;
      const peerCert = tlsSocket && typeof tlsSocket.getPeerCertificate === 'function' ? tlsSocket.getPeerCertificate(false) : null;
      const tlsAuthorized = tlsSocket ? Boolean(tlsSocket.authorized) : false;

      let certificate: PassiveTlsCertificate | null = null;
      if (peerCert && typeof peerCert === 'object' && Object.keys(peerCert).length > 0) {
        const validToMs = typeof peerCert.valid_to === 'string' ? Date.parse(peerCert.valid_to) : Number.NaN;
        const daysRemaining = Number.isFinite(validToMs)
          ? Math.floor((validToMs - nowFn().getTime()) / 86_400_000)
          : null;
        certificate = {
          subject: formatX509Name(peerCert.subject),
          issuer: formatX509Name(peerCert.issuer),
          validFrom: typeof peerCert.valid_from === 'string' ? cleanSingleLine(peerCert.valid_from, 80) : null,
          validTo: typeof peerCert.valid_to === 'string' ? cleanSingleLine(peerCert.valid_to, 80) : null,
          daysRemaining,
          subjectAltName: typeof peerCert.subjectaltname === 'string' ? cleanSingleLine(peerCert.subjectaltname, 1000) : null,
        };
      }

      const headers = sanitizeHeaders(res.headers);
      const redirect = inspectRedirect(origin, res.statusCode, res.headers.location);
      let bytesRead = 0;
      let truncated = false;

      const finishResponse = () => {
        done({
          origin,
          status: 'ok',
          httpStatus: res.statusCode ?? null,
          tlsProtocol: protocol ? cleanSingleLine(protocol, 40) : null,
          cipher: cipherInfo?.name ? cleanSingleLine(cipherInfo.name, 120) : null,
          tlsAuthorized,
          tlsErrorCode: null,
          tlsErrorMessage: null,
          errorCode: null,
          errorMessage: null,
          certificate,
          headers,
          redirectTargetOrigin: redirect.redirectTargetOrigin,
          redirectCrossOrigin: redirect.redirectCrossOrigin,
          redirectDowngradeHttp: redirect.redirectDowngradeHttp,
          bytesRead,
          truncated,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      };

      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk), 'utf8');
        if (bytesRead + size > maxResponseBytes) {
          bytesRead = maxResponseBytes;
          truncated = true;
          finishResponse();
          res.destroy();
          req?.destroy();
          return;
        }
        bytesRead += size;
      });
      const interrupted = () => fail('ECONNRESET', 'Resposta HTTPS interrompida antes do fim.');
      res.once('end', () => {
        if (res.complete) finishResponse();
        else interrupted();
      });
      res.once('close', interrupted);
      res.once('error', interrupted);
    });

    timer = setTimeout(() => {
      if (settled) return;
      fail('ETIMEDOUT', `Tempo limite excedido (${timeoutMs} ms) na medição passiva.`);
      req?.destroy();
    }, timeoutMs);

    req.once('error', err => {
      const errObj = err as NodeJS.ErrnoException;
      const code = cleanSingleLine(errObj.code || 'PROBE_ERROR', 120);
      const message = cleanSingleLine(errObj.message || 'Falha na conexão HTTPS.', 500);
      if (isTlsFailure(code, message)) {
        done({
          origin,
          status: 'tls_error',
          httpStatus: null,
          tlsProtocol: null,
          cipher: null,
          tlsAuthorized: false,
          tlsErrorCode: code,
          tlsErrorMessage: message,
          errorCode: null,
          errorMessage: null,
          certificate: null,
          headers: {},
          redirectTargetOrigin: null,
          redirectCrossOrigin: false,
          redirectDowngradeHttp: false,
          bytesRead: 0,
          truncated: false,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        return;
      }
      fail(code, 'Falha na conexão HTTPS.');
    });

    signal?.addEventListener('abort', cancel, {once: true});
    req.end();
  });
}

/** Collects passive TLS and header evidence across all authorized HTTPS origins of a project. */
export async function probePublishedHttpsOrigins(
  origins: readonly string[],
  options?: PassiveHttpsProbeOptions,
): Promise<ProntidaoPassiveEvidence> {
  if (origins.length === 0 || origins.length > MAX_DECLARED_ORIGINS) {
    throw new Refusal('VERIFY_LIMITS_INVALID', 400);
  }
  const authorized = origins.map(parseAuthorizedHttpsOrigin);
  const unmeasuredOrigins = authorized.slice(MAX_PRONTIDAO_ORIGINS);
  const targets: PassiveTlsTargetObservation[] = [];
  for (const origin of authorized.slice(0, MAX_PRONTIDAO_ORIGINS)) {
    targets.push(await probePublishedHttpsOrigin(origin, options));
  }
  return ProntidaoPassiveEvidence.parse({
    schemaVersion: 1,
    collectedBy: 'agent-control-prontidao-adapter',
    collectedAt: (options?.now ?? (() => new Date()))().toISOString(),
    targets,
    ...(unmeasuredOrigins.length > 0 ? {unmeasuredOrigins} : {}),
  });
}

export function validatePassiveTlsEvidence(raw: unknown): ProntidaoPassiveEvidence {
  return ProntidaoPassiveEvidence.parse(raw);
}
