import { z } from 'zod';

const segment = /^[A-Za-z0-9._@+-]+$/;

/** Exact relative file, or a directory prefix that already ends in '/'. */
export function isNormalizedProtectedGatePath(path: string): boolean {
  if (typeof path !== 'string' || path.length < 1 || path.length > 240) return false;
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) return false;
  const directory = path.endsWith('/');
  const body = directory ? path.slice(0, -1) : path;
  if (!body || body.endsWith('/')) return false;
  const parts = body.split('/');
  return parts.every(part => part !== '.' && part !== '..' && segment.test(part));
}

/** Keep the first occurrence. Publication stores this list, so the digest matches the parsed policy. */
export function dedupeProtectedGatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

function dedupeUnknown(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (seen.has(item)) continue;
      seen.add(item);
    }
    unique.push(item);
  }
  return unique;
}

export const protectedGatePathsSchema = z.optional(z.preprocess(
  dedupeUnknown,
  z.array(z.string().refine(isNormalizedProtectedGatePath, { message: 'PROTECTED_GATE_PATH_INVALID' })).max(64),
));

function unsafeWritePath(path: string): boolean {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) return true;
  return path.split('/').some(part => !part || part === '.' || part === '..');
}

/** A declared write path hits a protected file when it is that file or a parent directory.
 * A protected directory prefix also covers its descendants. Unsafe write paths fail closed. */
export function gatePathIntersects(writePath: string, protectedPath: string): boolean {
  if (unsafeWritePath(writePath) || !isNormalizedProtectedGatePath(protectedPath)) return true;
  const write = writePath.endsWith('/') ? writePath.slice(0, -1) : writePath;
  const directory = protectedPath.endsWith('/');
  const prot = directory ? protectedPath.slice(0, -1) : protectedPath;
  if (write === prot || prot.startsWith(write + '/')) return true;
  return directory && write.startsWith(prot + '/');
}

export function writePathsIntersectProtectedGate(writePaths: readonly string[], protectedGatePaths: readonly string[]): boolean {
  return protectedGatePaths.some(protectedPath => writePaths.some(writePath => gatePathIntersects(writePath, protectedPath)));
}
