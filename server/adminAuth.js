// server/adminAuth.js — verifies short-lived admin capability tokens issued by the matchmaker account service.
// The game nodes never read the account database: they only verify the HMAC signed with .secrets/watch-secret.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const secretFile = new URL('../../.secrets/watch-secret', import.meta.url);
function secret() {
  try { return readFileSync(secretFile, 'utf8').trim(); } catch { return ''; }
}

function readSigned(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 1024 || !token.includes('.')) return null;
  const sec = secret();
  if (!sec) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const want = createHmac('sha256', sec).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || data.v !== 1 || !Number.isFinite(data.exp) || data.exp <= Date.now()) return null;
    return data;
  } catch { return null; }
}

/** @param {unknown} token @returns {{ uid: number, role: 'owner'|'admin' } | null} */
export function readAdminToken(token) {
  const data = readSigned(token);
  if (!data) return null;
  if (data.role !== 'owner' && data.role !== 'admin') return null;
  return { uid: Number(data.uid) || 0, role: data.role };
}

/** @param {unknown} token @returns {{ uid: number, role: string, tag: string|null } | null} */
export function readUserToken(token) {
  const data = readSigned(token);
  if (!data) return null;
  if (!['player', 'owner', 'admin'].includes(data.role)) return null;
  const uid = Number(data.uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  const tag = typeof data.tag === 'string' && /^[0-9]{4}$/.test(data.tag) ? data.tag : null;
  return { uid, role: data.role, tag };
}

export const verifyAdminToken = (token) => readAdminToken(token) !== null;
