/**
 * Helpers de identificação: gera IDs curtos, valida paths lógicos.
 */
import { randomBytes, createHash } from 'node:crypto';

export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

export function normalizeLogicalPath(path: string): string {
  if (!path || path === '/') return '/';
  const parts = path.split('/').filter(Boolean);
  return '/' + parts.join('/');
}

export function joinLogical(a: string, b: string): string {
  if (a.endsWith('/')) return normalizeLogicalPath(a + b);
  return normalizeLogicalPath(a + '/' + b);
}

export function parentOf(path: string): string {
  if (path === '/' || !path.includes('/')) return '/';
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}
