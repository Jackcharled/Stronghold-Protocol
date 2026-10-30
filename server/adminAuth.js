// server/adminAuth.js — verifies short-lived admin capability tokens issued by the matchmaker account service.
// The game nodes never read the account database: they only verify the HMAC signed with .secrets/watch-secret.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

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
  // ★ 必须是验码令牌（typ='admin'）。登录身份令牌 accountToken 的 typ='user'，
  //   它的 role 也可能是 owner，若不加这一条就能冒充验码令牌绕过验证码。
  if (data.typ !== 'admin') return null;
  if (data.role !== 'owner' && data.role !== 'admin') return null;
  return { uid: Number(data.uid) || 0, role: data.role, iat: Number(data.iat) || 0 };
}

/** @param {unknown} token @returns {{ uid: number, role: string, tag: string|null } | null} */
export function readUserToken(token) {
  const data = readSigned(token);
  if (!data) return null;
  // 兼容旧令牌：typ 缺省视为登录身份令牌（user），但绝不接受 typ='admin'
  if (data.typ === 'admin') return null;
  if (!['player', 'owner', 'admin'].includes(data.role)) return null;
  const uid = Number(data.uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  const tag = typeof data.tag === 'string' && /^[0-9]{4}$/.test(data.tag) ? data.tag : null;
  return { uid, role: data.role, tag };
}

// ── 吊销支持（2026-10-31）───────────────────────────────────────────────
// 令牌是无状态 HMAC，无法单独作废某一枚。这里改用「吊销时间点」：
// 后台 /api/admintool/revoke 把一个时间戳写进 .secrets/admin-revoke-at（或环境变量），
// 节点读到它之后，凡是 iat 早于该时刻的 admin 令牌一律失效 —— 这就是「退出授权」。
// 读文件失败/不存在 → 不吊销（fail-open 到「按原样有效」，保证不会因缺文件锁死管理员）。
const revokeFile = new URL('../../.secrets/admin-revoke-at', import.meta.url);
let revokeCache = { at: -1, mtimeMs: 0 };
function revokedAt() {
  try {
    const st = statSync(revokeFile);
    if (st.mtimeMs !== revokeCache.mtimeMs) {
      const raw = readFileSync(revokeFile, 'utf8').trim();
      revokeCache = { at: Number(raw) || 0, mtimeMs: st.mtimeMs };
    }
    return revokeCache.at;
  } catch { return 0; }
}

export const verifyAdminToken = (token) => {
  const info = readAdminToken(token);
  if (!info) return false;
  const cut = revokedAt();
  if (cut > 0) {
    // 没有 iat 的老令牌：一旦发生过度吊销就一律作废（宁可让管理员重新换码，也不留后门）
    const iat = Number(info.iat) || 0;
    if (iat < cut) return false;
  }
  return true;
};
