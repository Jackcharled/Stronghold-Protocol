// matchmaker/account.cjs — 账号（QQ 邮箱验证码）+ 用户偏好（MySQL）
const crypto = require('node:crypto');
const fs = require('node:fs');
const nodemailer = require('nodemailer');

// 私有密钥：优先环境变量，其次项目根目录 .secrets/secrets.json（不进入仓库）
function readSecret(key) {
  try {
    const p = require('node:path').join(__dirname, '..', '.secrets', 'secrets.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j[key] || '';
  } catch { return ''; }
}

function watchSecret() {
  const p = require('node:path').join(__dirname, '..', '.secrets', 'watch-secret');
  try {
    const s = fs.readFileSync(p, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* create below */ }
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(require('node:path').dirname(p), { recursive: true });
    fs.writeFileSync(p, s, { mode: 0o600 });
  } catch { /* read-only deployment */ }
  return s;
}

// 短时管理员能力令牌：游戏节点用同一 watch-secret 验签，无需读取账号数据库。
function adminTokenFor(u) {
  if (!u || (u.role !== 'owner' && u.role !== 'admin')) return null;
  // typ 区分令牌用途：只有 typ='admin' 的才算验码令牌，accountToken（typ='user'）不能冒充
  //
  // ★ 2026-10-31：必须带 iat。
  //   server/adminAuth.js 的 verifyAdminToken 拿 iat 和「退出授权」记下的吊销时刻比：
  //   没有 iat 的令牌在吊销发生后一律作废（那边写得很明确：宁可重新换码也不留后门）。
  //   这条令牌以前没有 iat，于是管理员点过一次「退出授权」之后，
  //   账号登录带来的令牌**永远**是坏的 —— 游戏里怎么看都显示「需要验证码」，
  //   刷新也没用（维护者 2026-10-31 实测撞到）。
  //   加上 iat 之后语义才对：「我这次登录是在那次吊销之后，所以我是新授权」。
  const payload = Buffer.from(JSON.stringify({ v: 1, typ: 'admin', uid: u.id, role: u.role, iat: Date.now(), exp: Date.now() + 12 * 3600_000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', watchSecret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

// 登录账号的短期签名身份：游戏节点验签后只信 uid/tag，不再依赖可伪造的四位 tag。
function userTokenFor(u) {
  if (!u || !u.id) return null;
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    // typ='user'：登录身份令牌，不是验码令牌。verifyAdminToken 会拒绝它。
    typ: 'user',
    uid: u.id,
    role: u.role || 'player',
    tag: u.tag || null,
    exp: Date.now() + 7 * 24 * 3600_000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', watchSecret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

// 数据库连接只从环境变量 / .secrets/secrets.json 读取；代码里不写死账号、口令、库名
const DEFAULTS = {
  host: process.env.SP_DB_HOST || readSecret('dbHost') || '127.0.0.1',
  port: Number(process.env.SP_DB_PORT || readSecret('dbPort') || 3306),
  user: process.env.SP_DB_USER || readSecret('dbUser') || '',
  password: process.env.SP_DB_PASSWORD || readSecret('dbPassword') || '',
  database: process.env.SP_DB_NAME || readSecret('dbName') || '',
};

const MAIL = {
  // 主机 / 发件账号 / 授权码都只放在 .secrets/secrets.json（或环境变量），代码里不写死
  host: process.env.MAIL_HOST || readSecret('mailHost') || '',
  port: Number(process.env.MAIL_PORT || 465),
  secure: (process.env.MAIL_ENCRYPTION || 'ssl') === 'ssl',
  user: process.env.MAIL_USERNAME || readSecret('mailUser') || '',
  pass: process.env.MAIL_PASSWORD || readSecret('mailPassword') || '',
};

const SESSION_COOKIE = 'sp_sid';
const SESSION_DAYS = 30;
const DOMAINS = new Set(['identity', 'loadout', 'ownership', 'diy', 'skins', 'cosmetics', 'notices', 'annSeen', 'stats',
  // 名片干员（ui/seatArt.js 的 CARD_PREF 'room.card'）：玩家选的立绘。
  // 前端 account-title.js 的 PREF_MAP 早就有 card 这一项，但这里忘了加 —— 于是 PUT /api/prefs/card
  // 一直回 404 unknown_domain，立绘永远存不进账号，换设备/清缓存就丢（2026-10-27 实测确认）。
  'card']);

// ---------------- 管理员权限组（最高管理员可配置 admin 能用哪些功能） ----------------
const ADMIN_PERMISSIONS = [
  { key: 'accounts.view', label: '查看账号 / 账号详情', desc: '玩家账号列表、搜索、账号详情', def: true },
  { key: 'accounts.ban', label: '封禁 / 解封', desc: '封禁或解封等级更低的账号', def: true },
  { key: 'accounts.rename', label: '修改昵称', desc: '修改等级更低账号的昵称', def: true },
  { key: 'accounts.resetpw', label: '重置密码', desc: '重置等级更低账号的密码', def: true },
  { key: 'accounts.delete', label: '删除 / 恢复账号', desc: '软删除、已删除列表、恢复（高风险）', def: false },
  { key: 'accounts.role', label: '修改权限', desc: '调整等级更低账号的角色（高风险）', def: false },
  { key: 'audit.view', label: '查看审计日志', desc: '只读查看后台操作记录', def: true },
  { key: 'audit.export', label: '导出审计 CSV', desc: '导出最近 500 条审计', def: false },
  { key: 'nodes.view', label: '查看节点状态', desc: '30 节点在线 / 人数 / 对局 / 趋势', def: false },
  { key: 'nodes.restart', label: '重启游戏节点', desc: '从后台重启单个节点（高风险）', def: false },
  { key: 'storage.view', label: '查看数据占用', desc: '账号云端数据大小排行', def: false },
  { key: 'rooms.view', label: '查看所有房间号', desc: '各节点当前房间码、房间名单', def: false },
  // 2026-10-29 拆细：原来「看房间」和「动房间」是同一个 rooms.view，
  // 于是想看房间列表的人必然也能关房间。现在分成三个：
  //   rooms.view   只看
  //   rooms.abort  结束这一局（房间保留，玩家留在房里）
  //   rooms.close  关闭整个房间（玩家被移出同盟）
  { key: 'rooms.abort', label: '结束对局', desc: '结束房间当前这一局，房间与座位保留', def: false },
  { key: 'rooms.close', label: '关闭房间', desc: '手动关闭任意房间（玩家会被移出同盟）', def: false },
  { key: 'rooms.watch', label: '隐身观战', desc: '不占观战席地进入任意房间观战', def: false },
  { key: 'rooms.maintenance', label: '维护开关', desc: '创建房间 / 开始游戏 / 匹配队友的维护开关', def: false },
  // ⚠ 权限按【管理后台的页签】分组，一个页签一项（维护者 2026-10-29 定的规则）：
  //     玩家账号 → accounts.*    审计日志 → audit.*     已删除账号 → accounts.delete
  //     节点状态 → nodes.*       当前房间 → rooms.*     维护开关 → rooms.maintenance
  //     数据占用 → storage.view  服务器设置 → dash.settings（本项）
  //     权限设置 → 仅最高管理员（isOwner，不在本表里）
  // 所以「服务器设置」页签里的公告板、房间时长、nginx、日志等，仍然共用这一项，
  // 不再往下拆 —— 拆了就和页签对不上了。
  { key: 'dash.settings', label: '服务器设置', desc: '公告板、房间时长、维护开关、服务器状态、日志等', def: false },
  // 2026-10-31 新增：游戏内管理员工具（刷干员 / 装备 / 盟约 / 数值 / 阶段）。
  // 默认关闭 —— 它能让持有者在**正常对局**里直接改对局状态，属于高风险能力，
  // 必须由最高管理员在「权限设置」里手动勾上。勾上后：
  //   · 后台「游戏内管理员工具」卡片会显示，能生成 6 位验证码；
  //   · 游戏内点延迟胶囊 → 输码 → 面板可用 4 小时。
  // 没勾这项的 admin 即使在游戏里输了码，兑换接口也会返回 not_admin。
  { key: 'tools.game', label: '游戏内管理员工具', desc: '在正常对局里刷干员 / 装备 / 盟约 / 数值（高风险）', def: false },
];

/**
 * 权限预设模板（2026-10-29 新增）。
 *
 * 19 项权限逐个勾太麻烦，新加一个管理员经常漏掉关键项（尤其新增条目默认是关的）。
 * 这里给几个常见角色的一键组合；点一下套用，之后仍可手改任意项。
 * 与下方 DANGEROUS_PERMS 配合：任何预设都不含「删除账号 / 修改权限」。
 */
const PERM_PRESETS = [
  { id: 'readonly', label: '只能看，不能改', desc: '看账号、日志、节点、房间、数据占用，但不能做任何改动',
    keys: ['accounts.view', 'audit.view', 'nodes.view', 'storage.view', 'rooms.view', 'dash.settings'] },
  { id: 'support', label: '管玩家（封禁/改名/改密码）', desc: '处理玩家问题：看账号、封禁、改名、重置密码、隐身观战；不能动节点和房间',
    keys: ['accounts.view', 'accounts.ban', 'accounts.rename', 'accounts.resetpw',
      'audit.view', 'rooms.view', 'rooms.watch', 'dash.settings'] },
  { id: 'ops', label: '管房间（可关房/结束对局）', desc: '结束对局、关闭房间、隐身观战、维护开关、看日志和节点状态；不能重启节点、不能封禁或改账号',
    keys: ['accounts.view', 'audit.view', 'nodes.view', 'storage.view',
      'rooms.view', 'rooms.abort', 'rooms.close', 'rooms.watch', 'rooms.maintenance', 'dash.settings'] },
  { id: 'all', label: '全部（除三项高风险）', desc: '上面全部；「删除账号」「修改权限」「重启节点」属高风险，任何预设都不含，必须手动勾', keys: null },
];
/**
 * 危险权限：面板上标红，且**任何预设都不包含** —— 必须手动勾。
 *
 * 2026-10-29 维护者要求把「重启游戏节点」也算进来：重启一台节点会让上面的玩家
 * 断线重连（对局数据不丢，但会卡一下），和删账号、改权限同属「一按就影响很多人」。
 */
const DANGEROUS_PERMS = Object.freeze(['accounts.delete', 'accounts.role', 'nodes.restart']);

/** 把一个预设展开成实际的权限 key 列表（只保留本案里真实存在的项，去掉危险项）。 */
function expandPreset(preset) {
  const known = new Set(ADMIN_PERMISSIONS.map((p) => p.key));
  const base = preset && preset.keys
    ? preset.keys
    : ADMIN_PERMISSIONS.map((p) => p.key);   // 「全部」：所有非危险项
  return base.filter((k) => known.has(k) && !DANGEROUS_PERMS.includes(k));
}

const DEFAULT_ADMIN_PERMS = ADMIN_PERMISSIONS.filter((p) => p.def).map((p) => p.key);
let adminPermsCache = { at: 0, list: null };
async function getAdminPerms() {
  if (adminPermsCache.list && Date.now() - adminPermsCache.at < 5000) return adminPermsCache.list;
  try {
    const [rows] = await db().query("SELECT v FROM admin_settings WHERE k = 'admin_perms'");
    if (rows[0]) {
      const list = JSON.parse(rows[0].v);
      if (Array.isArray(list)) {
        const valid = list.filter((k) => ADMIN_PERMISSIONS.some((p) => p.key === k));
        adminPermsCache = { at: Date.now(), list: valid };
        return valid;
      }
    }
  } catch { /* 表还没建好 */ }
  adminPermsCache = { at: Date.now(), list: DEFAULT_ADMIN_PERMS };
  return DEFAULT_ADMIN_PERMS;
}
/** 某个 admin 账号是否被授予了某权限。
 *  权限表是全局的（所有 admin 共用 admin_perms 这一份），所以这里只查全局列表；
 *  只有 admin 角色会被限制，owner（最高管理员）在调用处直接放行。
 *  @param {number} _adminId 预留：以后若要按账号细分权限，改这里即可
 *  @param {string} key @returns {Promise<boolean>} */
async function adminHasPerm(_adminId, key) {
  const list = await getAdminPerms();
  return list.includes(key);
}

async function setAdminPerms(list) {
  const valid = [...new Set((Array.isArray(list) ? list : []).filter((k) => ADMIN_PERMISSIONS.some((p) => p.key === k)))];
  await db().query("INSERT INTO admin_settings (k, v) VALUES ('admin_perms', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(valid)]);
  adminPermsCache = { at: Date.now(), list: valid };
  return valid;
}
function adminCan(me, key) {
  if (!me) return false;
  if (me.role === 'owner') return true;
  return me.role === 'admin' && Array.isArray(me.perms) && me.perms.includes(key);
}
// 云端数据 schema：按域校验结构，并提供版本迁移入口（未来加字段时在此补 migrate）
const PREF_SCHEMA_VERSION = 1;
/**
 * 读取 user_prefs.payload。
 *
 * 历史上这里一律 `JSON.parse(row.payload)`，前提是写端总用 `JSON.stringify` 存。
 * 但字符串型域（card 的 charId）若以**裸字符串**落库，`JSON.parse('char_291_aglina')`
 * 会直接抛异常，整个 GET /api/prefs 变成 500 —— 所有域一起挂掉。
 * 这里兜住两种形态：能 parse 就用结果，parse 不了就把原文当字符串。
 */
function decodePrefPayload(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}
function validatePrefPayload(domain, payload) {
  if (domain === 'identity') {
    return typeof payload === 'string' ? payload.length <= 64 : (payload && typeof payload === 'object');
  }
  if (domain === 'annSeen') return payload === null || typeof payload === 'object';
  // 名片干员：payload 是一个 charId 字符串（'' = 默认立绘），不是对象。
  // 下面「非对象一律 false」的通用规则会把它拒掉，所以单独放行。
  if (domain === 'card') return typeof payload === 'string' && payload.length <= 64;
  if (payload === null || typeof payload !== 'object') return false;
  if (Array.isArray(payload)) return domain === 'notices' || domain === 'annSeen' || domain === 'stats';
  return true;
}
function migratePrefPayload(domain, payload, fromVer) {
  let v = Number(fromVer) || PREF_SCHEMA_VERSION;
  let out = payload;
  // 版本 1 为初始结构：保留占位，后续升级在这里按 v 逐级迁移
  if (v < PREF_SCHEMA_VERSION) v = PREF_SCHEMA_VERSION;
  return { payload: out, ver: v };
}

const DOMAIN_LIMIT = 64 * 1024;
const STATS_LIMIT = 2 * 1024 * 1024;

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODE_WINDOW_MS = 30 * 60 * 1000;
const CODE_MAX_PER_WINDOW = 5;
const CODE_MAX_ATTEMPTS = 5;
const DEV = process.env.SP_AUTH_DEV === '1';

let pool = null;
function db() {
  if (!pool) {
    if (!DEFAULTS.user || !DEFAULTS.password || !DEFAULTS.database) throw new Error('DB_NOT_CONFIGURED');
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({ ...DEFAULTS, waitForConnections: true, connectionLimit: 8, charset: 'utf8mb4' });
  }
  return pool;
}

let mailer = null;
function mail() {
  if (!mailer) {
    if (!MAIL.host || !MAIL.user) throw new Error('MAIL_NOT_CONFIGURED');
    mailer = nodemailer.createTransport({ host: MAIL.host, port: MAIL.port, secure: MAIL.secure, auth: { user: MAIL.user, pass: MAIL.pass } });
  }
  return mailer;
}

// 验证码邮件 HTML（深色卡片风格，避免外部图片被拦截）
function codeMailHtml(code) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#0a1012;font-family:'Noto Sans SC',Arial,sans-serif;color:#d8e6e3">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#0f181b;border:1px solid #22383b;border-radius:12px;overflow:hidden">
    <tr><td style="padding:26px 28px 8px;text-align:center">
      <div style="font-size:13px;letter-spacing:3px;color:#7ff0cf">萝 卜 喵 公 益 服</div>
      <div style="margin-top:6px;font-size:12px;letter-spacing:1px;color:#7f9a95">卫戍协议：盟约</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0;text-align:center">
      <div style="font-size:14px;color:#a9c4bf">你的注册验证码</div>
      <div style="margin:14px auto 0;display:inline-block;padding:12px 26px;border:1px solid #2f4a4f;border-radius:10px;background:#0b1416;font-size:30px;font-weight:700;letter-spacing:10px;color:#7ff0cf">${code}</div>
      <div style="margin-top:14px;font-size:12px;color:#7f9a95">验证码 10 分钟内有效，请勿转发给他人</div>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <div style="height:1px;background:#1e3235"></div>
    </td></tr>
    <tr><td style="padding:14px 28px 24px;text-align:center;font-size:12px;line-height:1.7;color:#6f8a86">
      若非本人操作，请忽略本邮件。<br />
      —— 萝卜喵公益服 · 卫戍协议：盟约
    </td></tr>
  </table>
</body></html>`;
}

// 反代后 req.socket 是 127.0.0.1，真实 IP 在 X-Forwarded-For / X-Real-IP
function ipOf(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  const first = xf.split(',')[0].trim();
  const real = String(req.headers['x-real-ip'] || '').trim();
  const ip = real || first || String(req.socket.remoteAddress || '');
  return ip.replace(/^::ffff:/, '').slice(0, 45);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, N, r, p, salt, hash] = String(stored).split('$');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: Number(N), r: Number(r), p: Number(p) });
    const want = Buffer.from(hash, 'base64');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieHeader(sid, maxAgeSec) {
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${process.env.SP_COOKIE_SECURE === '0' ? '' : '; Secure'}`;
}
function newSid() { return crypto.randomBytes(32).toString('base64url'); }
function displayOf(u) { return u && (u.nickname || null); }

// A tag is only a four-digit display discriminator, never an identity key. Duplicate tags are allowed.
function freshTag() { return String(crypto.randomInt(1000, 10000)); }

// ---- 博士代号（昵称）规则：按**显示宽度**计算，最多相当于 8 个汉字 ----
// 一个汉字（全角/宽字符）记 2，一个英文/数字记 1，因此：
//   8 个汉字 或 16 个英文/数字 或 4 汉字 + 8 英文 都可以。
// 允许的字符：任意语言文字字符（\p{L}）、数字（\p{N}）、下划线、短横线、间隔号「·」。
// 前端 matchmaker/public/account-title.js 的 nickProblem() 必须与这里保持一致。
const NICK_W_MAX = 16;            // 8 个汉字 = 16 个宽度单位
function nickWidth(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    const cp = ch.codePointAt(0);
    // 全角/宽字符（CJK、假名、韩文、全角标点等）计 2，其余计 1
    w += (cp >= 0x1100 && (
      cp <= 0x115f ||                       // Hangul Jamo
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||   // CJK … Yi
      (cp >= 0xac00 && cp <= 0xd7a3) ||     // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||     // CJK Compatibility Ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) ||     // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) ||     // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)      // CJK Ext B+
    )) ? 2 : 1;
  }
  return w;
}
const NICK_RE = /^[\p{L}\p{N}_\-·]+$/u;
/** @returns {null|{error:string, reason:string}} null 表示合法 */
function checkNickname(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { error: 'invalid_nickname', reason: 'empty' };
  if (!NICK_RE.test(s)) return { error: 'invalid_nickname', reason: 'charset' };
  if (nickWidth(s) > NICK_W_MAX) return { error: 'invalid_nickname', reason: 'too_long', width: nickWidth(s) };
  return null;
}

async function currentUser(req) {
  // Cookie 优先；被浏览器拦截时退回 Authorization: Bearer <sid>
  let sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) {
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,64})$/.exec(auth);
    if (m) sid = m[1];
  }
  if (!sid || !/^[A-Za-z0-9_-]{20,64}$/.test(sid)) return null;
  const [rows] = await db().query(
    'SELECT u.id, u.email, u.nickname, u.tag, u.name, u.role, s.expires_at FROM user_sessions s JOIN accounts u ON u.id = s.user_id WHERE s.sid = ? AND u.disabled = 0 AND u.deleted_at IS NULL',
    [sid],
  );
  const r = rows[0];
  if (!r || new Date(r.expires_at).getTime() < Date.now()) return null;
  const display = displayOf(r);
  return { id: r.id, email: r.email, nickname: r.nickname, tag: r.tag, role: r.role || 'player', name: display, displayName: display, titleName: r.nickname ? r.nickname + '#' + r.tag : null };
}

async function createSession(userId, req, res) {
  const sid = newSid();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db().query('INSERT INTO user_sessions (sid, user_id, expires_at, ua, ip) VALUES (?,?,?,?,?)',
    [sid, userId, expires, String(req.headers['user-agent'] || '').slice(0, 255), ipOf(req)]);
  res.setHeader('Set-Cookie', cookieHeader(sid, SESSION_DAYS * 86400));
  return sid;
}

function readBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        let text = chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}';
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        resolve(JSON.parse(text));
      } catch { reject(new Error('BAD_JSON')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const rate = new Map();
const FAILS = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const rec = rate.get(key) || { n: 0, t: now };
  if (now - rec.t > windowMs) { rec.n = 0; rec.t = now; }
  rec.n++; rate.set(key, rec);
  return rec.n > max;
}

const QQ_EMAIL = /^[1-9][0-9]{4,11}@qq\.com$/;

// ---- 图形验证码（内存，单进程 matchmaker）----
const captchaStore = new Map();
const CAPTCHA_TTL_MS = 3 * 60 * 1000;
const CAPTCHA_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function makeCaptcha() {
  const code = Array.from({ length: 4 }, () => CAPTCHA_CHARS[crypto.randomInt(0, CAPTCHA_CHARS.length)]).join('');
  const id = crypto.randomBytes(16).toString('base64url');
  captchaStore.set(id, { code, exp: Date.now() + CAPTCHA_TTL_MS });
  // 简单清理，避免长时间运行内存增长
  if (captchaStore.size > 5000) {
    const now = Date.now();
    for (const [k, v] of captchaStore) if (v.exp < now) captchaStore.delete(k);
  }
  return { id, code };
}

function captchaSvg(code) {
  const w = 120, h = 40;
  let noise = '';
  for (let i = 0; i < 6; i++) {
    const x1 = crypto.randomInt(0, w), y1 = crypto.randomInt(0, h);
    const x2 = crypto.randomInt(0, w), y2 = crypto.randomInt(0, h);
    noise += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3c5a5f" stroke-width="1" opacity=".6"/>`;
  }
  let chars = '';
  code.split('').forEach((ch, i) => {
    const x = 14 + i * 26 + crypto.randomInt(-2, 3);
    const y = 28 + crypto.randomInt(-3, 4);
    const rot = crypto.randomInt(-18, 19);
    chars += `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="700" fill="#8ff0d0">${ch}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#0b1416"/>${noise}${chars}</svg>`;
}

function checkCaptcha(body) {
  const id = String(body.captchaId || '');
  const text = String(body.captcha || '').trim().toUpperCase();
  const rec = captchaStore.get(id);
  if (!rec) return false;
  captchaStore.delete(id); // 一次性
  if (rec.exp < Date.now()) return false;
  return rec.code === text;
}
function validNickname(n) {
  const s = String(n || '').trim();
  if (s.length < 1 || s.length > 16) return null;
  if (!/^[\p{L}\p{N}_\-·]+$/u.test(s)) return null;
  return s;
}
const hashCode = (email, code) => crypto.createHash('sha256').update(email + ':' + code).digest('hex');

async function ensureSchema() {
  if (!DEFAULTS.database) throw new Error('DB_NOT_CONFIGURED');
  const mysql = require('mysql2/promise');
  const boot = await mysql.createConnection({ host: DEFAULTS.host, port: DEFAULTS.port, user: DEFAULTS.user, password: DEFAULTS.password });
  try {
    await boot.query(`CREATE DATABASE IF NOT EXISTS \`${DEFAULTS.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  } catch (e) {
    // 受限账号没有全局 CREATE：库已由管理员建好时继续；真正的连接/权限错误仍抛出
    if (![1044, 1045].includes(e.errno)) throw e;
  } finally { await boot.end(); }

  const c = await db().getConnection();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS accounts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(120) NULL,
      nickname VARCHAR(32) NULL,
      tag CHAR(4) NULL,
      name VARCHAR(40) NULL,
      pass_hash VARCHAR(255) NOT NULL,
      disabled TINYINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL,
      UNIQUE KEY uk_email (email),
      KEY idx_nick_tag (nickname, tag)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    for (const [col, ddl] of [['email', 'VARCHAR(120) NULL'], ['nickname', 'VARCHAR(32) NULL'], ['tag', 'CHAR(4) NULL']]) {
      try { await c.query(`ALTER TABLE accounts ADD COLUMN ${col} ${ddl}`); } catch { /* 已有 */ }
    }
    try { await c.query('ALTER TABLE accounts ADD UNIQUE KEY uk_email (email)'); } catch { /* 已有 */ }
    try { await c.query("ALTER TABLE accounts ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'player'"); } catch { /* 已有 */ }
    try { await c.query('ALTER TABLE accounts ADD COLUMN deleted_at DATETIME NULL'); } catch { /* 已有 */ }
    await c.query(`CREATE TABLE IF NOT EXISTS admin_devices (
      account_id BIGINT UNSIGNED NOT NULL,
      device CHAR(64) NOT NULL,
      ua VARCHAR(255) NULL,
      ip VARCHAR(45) NULL,
      first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_ip VARCHAR(45) NULL,
      last_seen TIMESTAMP NULL,
      PRIMARY KEY (account_id, device)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    // 异地登录提醒（游戏账号侧，2026-10-31）：老库补两列，记录该设备上次登录的 IP / 时间。
    // 只在管理员账号（role owner/admin）上用；普通玩家不写这张表，也就不会触发邮件。
    try { await c.query('ALTER TABLE admin_devices ADD COLUMN last_ip VARCHAR(45) NULL'); } catch { /* 已有 */ }
    try { await c.query('ALTER TABLE admin_devices ADD COLUMN last_seen TIMESTAMP NULL'); } catch { /* 已有 */ }
    // 老库遗留：name 必填 + 唯一键，会阻止「注册后再设代号」的流程
    try { await c.query('ALTER TABLE accounts MODIFY COLUMN name VARCHAR(40) NULL DEFAULT NULL'); } catch { /* 已可空 */ }
    try { await c.query('ALTER TABLE accounts DROP INDEX uk_name'); } catch { /* 无该索引 */ }

    await c.query(`CREATE TABLE IF NOT EXISTS admin_users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(32) NOT NULL,
      pass_hash VARCHAR(255) NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'admin',
      disabled TINYINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL,
      UNIQUE KEY uk_admin_name (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await c.query(`CREATE TABLE IF NOT EXISTS reset_codes (email VARCHAR(120) NOT NULL PRIMARY KEY, code_hash CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, attempts INT NOT NULL DEFAULT 0, last_sent_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await c.query(`CREATE TABLE IF NOT EXISTS admin_codes (email VARCHAR(120) NOT NULL PRIMARY KEY, code_hash CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, attempts INT NOT NULL DEFAULT 0, last_sent_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await c.query(`CREATE TABLE IF NOT EXISTS admin_sessions (
      token CHAR(43) NOT NULL PRIMARY KEY,
      admin_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      KEY idx_admin (admin_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await c.query(`CREATE TABLE IF NOT EXISTS admin_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      actor_id BIGINT UNSIGNED NULL,
      actor_email VARCHAR(120) NULL,
      action VARCHAR(32) NOT NULL,
      target_id BIGINT UNSIGNED NULL,
      detail VARCHAR(255) NULL,
      ip VARCHAR(45) NULL,
      at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_at (at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await c.query(`CREATE TABLE IF NOT EXISTS admin_settings (
      k VARCHAR(64) NOT NULL PRIMARY KEY,
      v TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    // 首次启动创建默认 owner（登录后台后请立即修改密码）
    try {
      const [cnt] = await c.query('SELECT COUNT(*) AS n FROM admin_users');
      if (!Number(cnt[0].n)) {
        await c.query('INSERT INTO admin_users (username, pass_hash, role) VALUES (?,?,?)', ['admin', hashPassword(process.env.SP_ADMIN_PASSWORD || 'Stronghold@2026'), 'owner']);
        console.log('[account] created default admin: admin');
      }
    } catch { /* 忽略 */ }
    await c.query(`CREATE TABLE IF NOT EXISTS email_codes (
      email VARCHAR(120) NOT NULL PRIMARY KEY,
      code_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_sent_at DATETIME NOT NULL,
      win_start DATETIME NOT NULL,
      win_count INT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await c.query(`CREATE TABLE IF NOT EXISTS user_sessions (
      sid CHAR(43) NOT NULL PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      ua VARCHAR(255) NULL,
      ip VARCHAR(45) NULL,
      KEY idx_user (user_id), KEY idx_exp (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await c.query(`CREATE TABLE IF NOT EXISTS user_prefs (
      user_id BIGINT UNSIGNED NOT NULL,
      domain VARCHAR(32) NOT NULL,
      payload JSON NOT NULL,
      version BIGINT UNSIGNED NOT NULL DEFAULT 1,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, domain)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } finally { c.release(); }
}

async function audit(actor, action, targetId, detail, ip) {
  try {
    await db().query('INSERT INTO admin_audit (actor_id, actor_email, action, target_id, detail, ip) VALUES (?,?,?,?,?,?)',
      [actor ? actor.id : null, actor ? (actor.email || null) : null, action, targetId || null, detail ? String(detail).slice(0, 255) : null, String(ip || '').slice(0, 45)]);
  } catch { /* 审计失败不影响主流程 */ }
}

async function handle(req, res, pathname) {
  const method = req.method;

  if (method === 'GET' && pathname === '/api/auth/me') {
    const u = await currentUser(req);
    // ★ 2026-10-31：这里**不再下发 adminToken**（维护者要求）。
    //   以前 /api/auth/me 和登录都顺手给一枚 adminToken，于是「登录了管理员账号」
    //   等于「游戏内管理员工具直接可用」—— 验码门形同虚设。
    //   维护者定的规则是：第一次打开必须先输授权码，4 小时后过期要重新输。
    //   所以 adminToken 只能由 /api/admintool/exchange 发（那边签 4 小时）。
    //   身份仍照常下发（user.role），前端靠它决定"要不要显示取码框"。
    return u ? sendJson(res, 200, { ok: true, user: u, userToken: userTokenFor(u) }) : sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }

  // 跨节点恢复：只告诉当前登录账号它自己所在的房间，不暴露全服房间目录。
  if (method === 'GET' && pathname === '/api/account/room') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    // 主判据是账号 ID：昵称会重名、会改，用昵称匹配会把玩家送去别人的对局。
    const uid = u.id != null ? String(u.id) : null;
    // 兼容旧数据：早期座位没有 accountId，只能退回昵称匹配。
    // 只在「该房间没有任何人带 accountId」时才用，避免抢到别人的房间。
    const names = new Set([u.nickname, u.name].filter(Boolean).map(String));
    let nameFallback = null;
    try {
      const r = await fetch('http://127.0.0.1:3080/api/status', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        for (const n of j?.rooms?.nodes || []) {
          for (const room of n.rooms || []) {
            // Only a live player match can be restored. A finished match's room may still
            // exist with its players in the lobby, and spectators are never restorable.
            if (room.started !== true) continue;
            const players = (room.players || []).filter(Boolean);
            // 1) 账号 ID 精确命中：这是唯一可信的判据
            if (uid && players.some((p) => p && p.accountId != null && String(p.accountId) === uid)) {
              return sendJson(res, 200, { ok: true, room: { code: room.code, node: Number(n.n) || null }, by: 'account' });
            }
            // 2) 昵称兜底：只在该房间所有座位都没有 accountId（纯旧数据）时记录，稍后再决定
            if (!nameFallback) {
              const anyHasAccount = players.some((p) => p && p.accountId != null);
              if (!anyHasAccount && players.some((p) => p && names.has(String(p.name)))) {
                nameFallback = { code: room.code, node: Number(n.n) || null };
              }
            }
          }
        }
      }
    } catch { /* fall through: no room */ }
    if (nameFallback) return sendJson(res, 200, { ok: true, room: nameFallback, by: 'name-legacy' });
    return sendJson(res, 200, { ok: true, room: null });
  }

  // 内部接口（只给 nginx 用，仅本机可访问）：这个登录账号在 node=N 上有没有房间？
  //
  // 背景：nginx 的 map $cookie_sp_route 原本让「所有存活节点」都能粘住 cookie，
  // 于是 30 天有效的老 cookie 会把玩家带回旧代码节点 —— 哪怕他根本不在对局中。
  // nginx 查不了数据库，所以在这里提供一个只回 204/404 的极简接口，配 auth_request 用。
  //
  // 鉴权：只看 nginx 转发来的 X-Real-IP 是否本机（公网访问直接 403），
  // 且必须带登录 session（否则视为「没有房间」→ 不粘 → 走随机新节点，安全侧）。
  if (method === 'GET' && pathname === '/api/account/room-on-node') {
    const ip = ipOf(req) || '';
    if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
      res.writeHead(403, { 'cache-control': 'no-store' });
      return res.end();
    }
    const u = await currentUser(req);
    if (!u) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end(); }
    const wantNode = Number(new URL(req.url, 'http://x').searchParams.get('node'));
    if (!Number.isInteger(wantNode) || wantNode < 1 || wantNode > 30) {
      res.writeHead(400, { 'cache-control': 'no-store' });
      return res.end();
    }
    const uid = u.id != null ? String(u.id) : null;
    let has = false;
    try {
      const r = await fetch('http://127.0.0.1:3080/api/status', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        for (const n of j?.rooms?.nodes || []) {
          if (Number(n.n) !== wantNode) continue;
          for (const room of n.rooms || []) {
            // 只认「已开局的对局」：大厅里等人不算（那种情况刷新不会掉线）。
            if (room.started !== true) continue;
            const players = (room.players || []).filter(Boolean);
            if (uid && players.some((x) => x && x.accountId != null && String(x.accountId) === uid)) { has = true; break; }
          }
          if (has) break;
        }
      }
    } catch { /* 查不到 = 没有房间 */ }
    res.writeHead(has ? 204 : 404, {
      'cache-control': 'no-store',
      ...(has ? { 'X-SP-Room-On-Node': String(wantNode) } : {}),
    });
    return res.end();
  }
  if (method === 'POST' && pathname === '/api/auth/send-code') {
    const ip = ipOf(req) || '?';
    if (limited('code-ip:' + ip, 20, 60 * 60 * 1000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests', retryAfter: 60 });
    const body = await readBody(req, 8 * 1024);
    const email = String(body.email || '').trim().toLowerCase();
    if (!QQ_EMAIL.test(email)) return sendJson(res, 400, { ok: false, error: 'invalid_email' });

    const [mine] = await db().query('SELECT 1 FROM accounts WHERE email = ? AND deleted_at IS NULL', [email]);
    if (mine[0]) return sendJson(res, 409, { ok: false, error: 'email_taken' });

    const now = new Date();
    const [rows] = await db().query('SELECT last_sent_at, win_start, win_count FROM email_codes WHERE email = ?', [email]);
    const row = rows[0];
    if (row) {
      const last = new Date(row.last_sent_at).getTime();
      if (now.getTime() - last < CODE_RESEND_MS) {
        return sendJson(res, 429, { ok: false, error: 'too_soon', retryAfter: Math.ceil((CODE_RESEND_MS - (now.getTime() - last)) / 1000) });
      }
      let winStart = new Date(row.win_start).getTime();
      const winCount = Number(row.win_count) || 0;
      if (now.getTime() - winStart > CODE_WINDOW_MS) { winStart = now.getTime(); }
      else if (winCount >= CODE_MAX_PER_WINDOW) {
        return sendJson(res, 429, { ok: false, error: 'too_many_codes', retryAfter: Math.ceil((CODE_WINDOW_MS - (now.getTime() - winStart)) / 1000) });
      }
    }

    const code = String(crypto.randomInt(100000, 1000000));
    try {
      await mail().sendMail({
        from: `"萝卜喵公益服" <${MAIL.user}>`,
        to: email,
        subject: '【萝卜喵公益服】卫戍协议：盟约 · 注册验证码',
        text: `你的注册验证码是 ${code}，10 分钟内有效。若非本人操作请忽略。\n\n—— 萝卜喵公益服 · 卫戍协议：盟约`,
        html: codeMailHtml(code),
      });
    } catch {
      return sendJson(res, 502, { ok: false, error: 'mail_failed' });
    }

    const inWindow = row && now.getTime() - new Date(row.win_start).getTime() <= CODE_WINDOW_MS;
    const nextWinStart = inWindow ? new Date(row.win_start) : now;
    const nextCount = inWindow ? Number(row.win_count) + 1 : 1;
    await db().query(
      `INSERT INTO email_codes (email, code_hash, expires_at, attempts, last_sent_at, win_start, win_count)
       VALUES (?,?,?,0,?,?,?)
       ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), expires_at = VALUES(expires_at), attempts = 0,
         last_sent_at = VALUES(last_sent_at), win_start = VALUES(win_start), win_count = VALUES(win_count)`,
      [email, hashCode(email, code), new Date(now.getTime() + CODE_TTL_MS), now, nextWinStart, nextCount],
    );
    return sendJson(res, 200, { ok: true, cooldown: 60, ...(DEV ? { devCode: code } : {}) });
  }

  if (method === 'GET' && pathname === '/api/auth/captcha') {
    const { id, code } = makeCaptcha();
    return sendJson(res, 200, { ok: true, id, svg: captchaSvg(code), ttl: Math.round(CAPTCHA_TTL_MS / 1000) });
  }

  if (method === 'POST' && pathname === '/api/auth/register') {
    const ip = ipOf(req) || '?';
    if (limited('reg:' + ip, 10, 60_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    const body = await readBody(req, 8 * 1024);
    if (!checkCaptcha(body)) return sendJson(res, 400, { ok: false, error: 'captcha_wrong' });
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const pw = String(body.password || '');
    if (!QQ_EMAIL.test(email)) return sendJson(res, 400, { ok: false, error: 'invalid_email' });
    if (!/^[0-9]{6}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'invalid_code' });
    if (pw.length < 8 || pw.length > 128) return sendJson(res, 400, { ok: false, error: 'invalid_password' });

    const [rows] = await db().query('SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?', [email]);
    const rec = rows[0];
    if (!rec) return sendJson(res, 400, { ok: false, error: 'code_required' });
    if (new Date(rec.expires_at).getTime() < Date.now()) return sendJson(res, 400, { ok: false, error: 'code_expired' });
    if (Number(rec.attempts) >= CODE_MAX_ATTEMPTS) return sendJson(res, 429, { ok: false, error: 'code_attempts' });
    if (rec.code_hash !== hashCode(email, code)) {
      await db().query('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?', [email]);
      return sendJson(res, 400, { ok: false, error: 'code_wrong' });
    }

    try {
      // 注册只分配 4 位代码；昵称由玩家登录后首次输入
      const tag = freshTag();
      const [r] = await db().query(
        'INSERT INTO accounts (email, tag, pass_hash) VALUES (?,?,?)',
        [email, tag, hashPassword(pw)],
      );
      await db().query('DELETE FROM email_codes WHERE email = ?', [email]);
      const sid = await createSession(r.insertId, req, res);
      const created = { id: r.insertId, email, nickname: null, tag, role: 'player', name: null, displayName: null };
      return sendJson(res, 200, { ok: true, token: sid, userToken: userTokenFor(created), user: created });
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') return sendJson(res, 409, { ok: false, error: 'email_taken' });
      return sendJson(res, 500, { ok: false, error: 'server_error' });
    }
  }

  // 登录设备列表 / 退出其他设备
  if (method === 'GET' && pathname === '/api/auth/sessions') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const sid = parseCookies(req)[SESSION_COOKIE] || '';
    const [rows] = await db().query('SELECT sid, ua, ip, created_at, expires_at FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [u.id]);
    const sessions = rows.map((r) => ({ current: r.sid === sid, ua: r.ua || '', ip: r.ip || '', createdAt: r.created_at, expiresAt: r.expires_at }));
    return sendJson(res, 200, { ok: true, sessions });
  }
  if (method === 'POST' && pathname === '/api/auth/sessions/revoke') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const sid = parseCookies(req)[SESSION_COOKIE] || '';
    await db().query('DELETE FROM user_sessions WHERE user_id = ? AND sid <> ?', [u.id, sid]);
    await audit({ id: u.id, email: u.email }, 'self-revoke-sessions', u.id, null, ipOf(req));
    return sendJson(res, 200, { ok: true });
  }
  // 修改密码
  if (method === 'POST' && pathname === '/api/auth/password') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const body = await readBody(req, 8 * 1024);
    const oldPw = String(body.oldPassword || '');
    const newPw = String(body.newPassword || '');
    if (newPw.length < 8 || newPw.length > 128) return sendJson(res, 400, { ok: false, error: 'invalid_password' });
    const [rows] = await db().query('SELECT pass_hash FROM accounts WHERE id = ?', [u.id]);
    if (!rows[0] || !verifyPassword(oldPw, rows[0].pass_hash)) return sendJson(res, 400, { ok: false, error: 'bad_old_password' });
    await db().query('UPDATE accounts SET pass_hash = ? WHERE id = ?', [hashPassword(newPw), u.id]);
    const sid = parseCookies(req)[SESSION_COOKIE] || '';
    await db().query('DELETE FROM user_sessions WHERE user_id = ? AND sid <> ?', [u.id, sid]);
    await audit({ id: u.id, email: u.email }, 'self-change-password', u.id, null, ipOf(req));
    return sendJson(res, 200, { ok: true });
  }
  // 修改代号（昵称），四位代码不变
  if (method === 'POST' && pathname === '/api/auth/set-name') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const body = await readBody(req, 8 * 1024);
    const nickname = String(body.nickname || '').trim();
    const bad = checkNickname(nickname);
    if (bad) return sendJson(res, 400, { ok: false, ...bad });
    const tag = freshTag();
    await db().query('UPDATE accounts SET nickname = ?, name = ?, tag = ? WHERE id = ?', [nickname, nickname + '#' + tag, tag, u.id]);
    const display = nickname + '#' + tag;
    const next = { ...u, nickname, tag, name: display, displayName: display, titleName: display };
    // ★ 2026-10-31：改名也不再补发 adminToken（原样保留手头那枚 4 小时的兑换令牌即可）。
    return sendJson(res, 200, { ok: true, userToken: userTokenFor(next), user: next });
  }
  // （这里原有一段重复的 /api/auth/set-name 分支，永远不可达——上面的同名路由已先行 return。
  //   它写的是 name = nickname（不带 #代码），与实际生效的逻辑相反，容易误导，已删除。）

  if (method === 'POST' && pathname === '/api/auth/login') {
    const ip = ipOf(req) || '?';
    const body = await readBody(req, 8 * 1024);
    if (!checkCaptcha(body)) return sendJson(res, 400, { ok: false, error: 'captcha_wrong' });
    const email = String(body.email || '').trim().toLowerCase();
    if (limited('login:' + ip + ':' + email, 10, 60_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    const [rows] = await db().query('SELECT id, email, nickname, tag, name, role, pass_hash, disabled FROM accounts WHERE email = ? AND deleted_at IS NULL', [email]);
    const u = rows[0];
    if (!u || u.disabled || !verifyPassword(String(body.password || ''), u.pass_hash)) {
      return sendJson(res, 401, { ok: false, error: 'bad_credentials' });
    }
    await db().query('UPDATE accounts SET last_login_at = NOW() WHERE id = ?', [u.id]);
    // 异地登录提醒（游戏账号侧，2026-10-31）。
    // 背景：管理员工具（游戏内 F9 面板）靠「登录游戏账号时下发的 adminToken」授权，
    // 所以游戏账号登录也成了拿到管理权限的途径 —— 必须能在异常登录时通知服主。
    //
    // 只在管理员账号上做（role owner/admin）：普通玩家一个邮件都不发，避免骚扰。
    // 发信条件（维护者定稿）：**新设备 或 IP 和这台设备上次登录的 IP 不同**。
    //   同一台设备 + 同一 IP 反复登录 → 不发；
    //   常用设备换了网络 → 发（异地）；
    //   新设备（同网络也算）→ 发（新设备）。
    // device = sha256(ua + '|' + accept-language)，和后台登录用的是同一种指纹。
    if (u.role === 'owner' || u.role === 'admin') {
      try {
        const ua = String(req.headers['user-agent'] || '').slice(0, 255);
        const lang = String(req.headers['accept-language'] || '');
        const dev = crypto.createHash('sha256').update(ua + '|' + lang).digest('hex');
        const [known] = await db().query('SELECT last_ip FROM admin_devices WHERE account_id = ? AND device = ?', [u.id, dev]);
        const prevIp = known[0] ? (known[0].last_ip || null) : null;
        const isNewDevice = !known[0];
        const ipChanged = !isNewDevice && prevIp != null && prevIp !== ip;
        if (isNewDevice || ipChanged) {
          const [owners] = await db().query("SELECT email FROM accounts WHERE role = 'owner' AND email IS NOT NULL AND deleted_at IS NULL");
          const what = isNewDevice ? '在新设备登录' : '在异地登录（IP 变了）';
          const subject = '【萝卜喵公益服】管理员账号' + what;
          const text = '管理员账号 ' + (u.email || '') + '（' + (u.nickname || '') + '#' + (u.tag || '') + '）' + what + '。\n'
            + 'IP: ' + ip + (ipChanged ? '（上次 ' + prevIp + '）' : '') + '\n'
            + 'UA: ' + ua + '\n'
            + (u.role === 'owner' ? '' : '')
            + '如非本人操作，请立即到后台重置密码或收回权限。\n\n—— 萝卜喵公益服 · 卫戍协议：盟约';
          for (const o of owners) {
            if (!o.email) continue;
            try { await mail().sendMail({ from: `"萝卜喵公益服" <${MAIL.user}>`, to: o.email, subject, text }); } catch { /* 忽略 */ }
          }
          await audit({ id: u.id, email: u.email }, isNewDevice ? 'game-new-device' : 'game-ip-changed', u.id, ip, ip);
        }
        // 每次登录都刷新该设备的最后 IP / 时间（新设备也顺手插一条）
        await db().query(
          'INSERT INTO admin_devices (account_id, device, ua, ip, last_ip, last_seen) VALUES (?,?,?,?,?,NOW()) '
          + 'ON DUPLICATE KEY UPDATE last_ip = VALUES(last_ip), last_seen = NOW(), ua = VALUES(ua)',
          [u.id, dev, ua, ip, ip],
        );
      } catch { /* 设备识别 / 发信失败都不影响登录 */ }
    }
    const sid = await createSession(u.id, req, res);
    const display = displayOf(u);
    // ★ 2026-10-31：登录**不再下发 adminToken**，理由同 /api/auth/me（见那处注释）。
    //   管理员要用游戏内工具，必须到后台生成验证码再兑换 —— 这是验码门存在的意义。
    return sendJson(res, 200, { ok: true, token: sid, userToken: userTokenFor(u), user: { id: u.id, email: u.email, nickname: u.nickname, tag: u.tag, role: u.role || 'player', name: display, displayName: display, titleName: u.nickname ? u.nickname + '#' + u.tag : null } });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) await db().query('DELETE FROM user_sessions WHERE sid = ?', [sid]);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return sendJson(res, 200, { ok: true });
  }

  // ---------------- 管理员登录（网页后台）----------------
  if (method === 'POST' && pathname === '/api/admin/login') {
    const body = await readBody(req, 8 * 1024);
    const username = String(body.username || '').trim();
    if (limited('adminlogin:' + (ipOf(req) || '?'), 10, 60_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    const [rows] = await db().query('SELECT id, username, pass_hash, role, disabled FROM admin_users WHERE username = ?', [username]);
    const a = rows[0];
    if (!a || a.disabled || !verifyPassword(String(body.password || ''), a.pass_hash)) return sendJson(res, 401, { ok: false, error: 'bad_credentials' });
    const token = newSid();
    await db().query('INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?,?,?)', [token, a.id, new Date(Date.now() + 12 * 3600_000)]);
    await db().query('UPDATE admin_users SET last_login_at = NOW() WHERE id = ?', [a.id]);
    return sendJson(res, 200, { ok: true, token, admin: { id: a.id, username: a.username, role: a.role } });
  }

  if (pathname.startsWith('/api/admin/') && !pathname.startsWith('/api/admin/login')) {
    const body0 = { token: '' };
    const auth = String(req.headers.authorization || '');
    const bm = /^Bearer\s+([A-Za-z0-9_-]{20,64})$/.exec(auth);
    if (bm) body0.token = bm[1];
    const [sess] = body0.token
      ? await db().query('SELECT s.admin_id, s.expires_at, u.username, u.role, u.disabled FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_id WHERE s.token = ?', [body0.token])
      : [[]];
    const me2 = sess[0];
    if (!me2 || me2.disabled || new Date(me2.expires_at).getTime() < Date.now()) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const isOwner = me2.role === 'owner';

    if (method === 'GET' && pathname === '/api/admin/me') return sendJson(res, 200, { ok: true, admin: { id: me2.admin_id, username: me2.username, role: me2.role } });

    if (method === 'POST' && pathname === '/api/admin/logout') {
      await db().query('DELETE FROM admin_sessions WHERE token = ?', [body0.token]);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET' && pathname === '/api/admin/accounts') { /* handled below */ }

    // 管理员账号管理（仅 owner）
    if (pathname === '/api/admin/users') {
      if (!isOwner) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      if (method === 'GET') {
        const [rows] = await db().query('SELECT id, username, role, disabled, created_at, last_login_at FROM admin_users ORDER BY id');
        return sendJson(res, 200, { ok: true, users: rows });
      }
      if (method === 'POST') {
        const body = await readBody(req, 8 * 1024);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const role = body.role === 'owner' ? 'owner' : (body.role === 'moderator' ? 'moderator' : 'admin');
        if (!/^[A-Za-z0-9_\-]{3,32}$/.test(username)) return sendJson(res, 400, { ok: false, error: 'invalid_username' });
        if (password.length < 8) return sendJson(res, 400, { ok: false, error: 'invalid_password' });
        try {
          const [r] = await db().query('INSERT INTO admin_users (username, pass_hash, role) VALUES (?,?,?)', [username, hashPassword(password), role]);
          return sendJson(res, 200, { ok: true, id: r.insertId });
        } catch (e) { if (e && e.code === 'ER_DUP_ENTRY') return sendJson(res, 409, { ok: false, error: 'name_taken' }); return sendJson(res, 500, { ok: false, error: 'server_error' }); }
      }
    }
    const mu = /^\/api\/admin\/users\/([0-9]+)\/(disabled|password)$/.exec(pathname);
    if (mu && method === 'POST') {
      if (!isOwner) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const id = Number(mu[1]);
      const body = await readBody(req, 8 * 1024);
      if (mu[2] === 'disabled') {
        const disabled = body.disabled === true ? 1 : 0;
        await db().query('UPDATE admin_users SET disabled = ? WHERE id = ?', [disabled, id]);
        if (disabled) await db().query('DELETE FROM admin_sessions WHERE admin_id = ?', [id]);
        return sendJson(res, 200, { ok: true });
      }
            const pw = String(body.password || '');
      if (pw.length < 8) return sendJson(res, 400, { ok: false, error: 'invalid_password' });
      await db().query('UPDATE admin_users SET pass_hash = ? WHERE id = ?', [hashPassword(pw), id]);
      await db().query('DELETE FROM admin_sessions WHERE admin_id = ?', [id]);
      return sendJson(res, 200, { ok: true });
    }

    // 玩家账号管理：复用后续 /api/admin/accounts 逻辑（去掉本机限制）
    if (method === 'GET' && pathname === '/api/admin/accounts') {
      const u2 = new URL(req.url, 'http://x');
      const q = String(u2.searchParams.get('q') || '').trim();
      const onlyDeleted = u2.searchParams.get('deleted') === '1';
      const like = '%' + q + '%';
      const [rows] = q
        ? await db().query('SELECT id, email, nickname, tag, disabled, created_at, last_login_at FROM accounts WHERE email LIKE ? OR nickname LIKE ? OR tag LIKE ? ORDER BY id DESC LIMIT 200', [like, like, like])
        : await db().query('SELECT id, email, nickname, tag, disabled, created_at, last_login_at FROM accounts ORDER BY id DESC LIMIT 200');
      const [agg] = await db().query('SELECT COUNT(*) AS total, SUM(disabled = 1) AS disabled FROM accounts');
      return sendJson(res, 200, { ok: true, accounts: rows, total: Number(agg[0].total) || 0, disabled: Number(agg[0].disabled) || 0 });
    }
    const macc = /^\/api\/admin\/accounts\/([0-9]+)\/(disabled|password)$/.exec(pathname);
    if (macc && method === 'POST') {
      const id = Number(macc[1]);
      const body = await readBody(req, 8 * 1024);
      if (macc[2] === 'disabled') {
        const disabled = body.disabled === true ? 1 : 0;
        await db().query('UPDATE accounts SET disabled = ? WHERE id = ?', [disabled, id]);
        await audit({ id: me2.admin_id, email: me2.email }, disabled ? 'disable' : 'enable', id, null, ipOf(req));
        if (disabled) await db().query('DELETE FROM user_sessions WHERE user_id = ?', [id]);
        return sendJson(res, 200, { ok: true });
      }
      const pw = String(body.password || '');
      if (pw.length < 8) return sendJson(res, 400, { ok: false, error: 'invalid_password' });
      await db().query('UPDATE accounts SET pass_hash = ? WHERE id = ?', [hashPassword(pw), id]);
      await db().query('DELETE FROM user_sessions WHERE user_id = ?', [id]);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---------------- 后台账号管理（仅本机可访问）----------------
  if (pathname.startsWith('/api/admin/')) {
    const ra = ipOf(req);
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ra)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    if (method === 'GET' && pathname === '/api/admin/accounts') {
      const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
      const like = '%' + q + '%';
      const [rows] = q
        ? await db().query('SELECT id, email, nickname, tag, disabled, created_at, last_login_at FROM accounts WHERE email LIKE ? OR nickname LIKE ? OR tag LIKE ? ORDER BY id DESC LIMIT 200', [like, like, like])
        : await db().query('SELECT id, email, nickname, tag, disabled, created_at, last_login_at FROM accounts ORDER BY id DESC LIMIT 200');
      const [agg] = await db().query('SELECT COUNT(*) AS total, SUM(disabled = 1) AS disabled FROM accounts');
      return sendJson(res, 200, { ok: true, accounts: rows, total: Number(agg[0].total) || 0, disabled: Number(agg[0].disabled) || 0 });
    }

    let m2 = /^\/api\/admin\/accounts\/([0-9]+)\/disabled$/.exec(pathname);
    if (m2 && method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const disabled = body.disabled === true ? 1 : 0;
      await db().query('UPDATE accounts SET disabled = ? WHERE id = ?', [disabled, Number(m2[1])]);
      if (disabled) await db().query('DELETE FROM user_sessions WHERE user_id = ?', [Number(m2[1])]);
      return sendJson(res, 200, { ok: true, id: Number(m2[1]), disabled: !!disabled });
    }

    m2 = /^\/api\/admin\/accounts\/([0-9]+)\/password$/.exec(pathname);
    if (m2 && method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const pw = String(body.password || '');
      if (pw.length < 8 || pw.length > 128) return sendJson(res, 400, { ok: false, error: 'invalid_password' });
      await db().query('UPDATE accounts SET pass_hash = ? WHERE id = ?', [hashPassword(pw), Number(m2[1])]);
      await db().query('DELETE FROM user_sessions WHERE user_id = ?', [Number(m2[1])]);
      return sendJson(res, 200, { ok: true, id: Number(m2[1]) });
    }
  }

  // ---------------- 账号权限（后台直接用玩家账号登录）----------------
  // 忘记密码：邮箱验证码重置
  if (method === 'POST' && pathname === '/api/auth/reset/send') {
    const body = await readBody(req, 8 * 1024);
    const email = String(body.email || '').trim().toLowerCase();
    if (!QQ_EMAIL.test(email)) return sendJson(res, 400, { ok: false, error: 'invalid_email' });
    if (limited('rsend:' + email, 1, 55_000)) return sendJson(res, 429, { ok: false, error: 'too_soon', retryAfter: 55 });
    if (limited('rsend-day:' + email, 5, 24 * 3600_000)) return sendJson(res, 429, { ok: false, error: 'too_many_codes' });
    if (limited('rsend-ip:' + (ipOf(req) || '?'), 10, 3600_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    const [rows] = await db().query('SELECT id FROM accounts WHERE email = ? AND deleted_at IS NULL', [email]);
    // 无论是否存在都返回成功，避免探测邮箱是否注册
    if (rows[0]) {
      const code = String(crypto.randomInt(100000, 1000000));
      await db().query('INSERT INTO reset_codes (email, code_hash, expires_at, attempts, last_sent_at) VALUES (?,?,?,0,?) ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), expires_at = VALUES(expires_at), attempts = 0, last_sent_at = VALUES(last_sent_at)', [email, hashCode(email, code), new Date(Date.now() + 10 * 60_000), new Date()]);
      try { await mail().sendMail({ from: `"萝卜喵公益服" <${MAIL.user}>`, to: email, subject: '【萝卜喵公益服】重置密码验证码', text: `你的重置密码验证码是 ${code}，10 分钟内有效。如非本人操作请忽略。\n\n—— 萝卜喵公益服 · 卫戍协议：盟约`, html: codeMailHtml(code) }); } catch { /* 邮件失败不暴露 */ }
    }
    return sendJson(res, 200, { ok: true, cooldown: 60 });
  }
  if (method === 'POST' && pathname === '/api/auth/reset') {
    const body = await readBody(req, 8 * 1024);
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const pw = String(body.password || '');
    if (!QQ_EMAIL.test(email)) return sendJson(res, 400, { ok: false, error: 'invalid_email' });
    if (!/^[0-9]{6}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'invalid_code' });
    if (pw.length < 8) return sendJson(res, 400, { ok: false, error: 'invalid_password' });
    if (limited('reset:' + email, 10, 3600_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    const [rows] = await db().query('SELECT id, email FROM accounts WHERE email = ? AND deleted_at IS NULL', [email]);
    const a = rows[0];
    if (!a) return sendJson(res, 400, { ok: false, error: 'code_wrong' });
    const [cr] = await db().query('SELECT code_hash, expires_at, attempts FROM reset_codes WHERE email = ?', [email]);
    const rec = cr[0];
    if (!rec) return sendJson(res, 400, { ok: false, error: 'code_required' });
    if (new Date(rec.expires_at).getTime() < Date.now()) return sendJson(res, 400, { ok: false, error: 'code_expired' });
    if (Number(rec.attempts) >= 5) return sendJson(res, 429, { ok: false, error: 'code_attempts' });
    if (rec.code_hash !== hashCode(email, code)) { await db().query('UPDATE reset_codes SET attempts = attempts + 1 WHERE email = ?', [email]); return sendJson(res, 400, { ok: false, error: 'code_wrong' }); }
    await db().query('DELETE FROM reset_codes WHERE email = ?', [email]);
    await db().query('UPDATE accounts SET pass_hash = ? WHERE id = ?', [hashPassword(pw), a.id]);
    await db().query('DELETE FROM user_sessions WHERE user_id = ?', [a.id]);
    await audit({ id: a.id, email }, 'self-reset-password', a.id, null, ipOf(req));
    return sendJson(res, 200, { ok: true });
  }
  // 管理员登录：必须已有游戏登录态（Cookie 会话），再通过邮箱验证码二次验证
  if (method === 'GET' && pathname === '/api/admin2/whoami') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'login_required' });
    if (!u.role || u.role === 'player') return sendJson(res, 403, { ok: false, error: 'not_admin' });
    return sendJson(res, 200, { ok: true, user: { id: u.id, email: u.email, nickname: u.nickname, tag: u.tag, role: u.role } });
  }
  if (method === 'POST' && pathname === '/api/admin2/send-code') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'login_required' });
    if (!u.role || u.role === 'player') return sendJson(res, 403, { ok: false, error: 'not_admin' });
    if (!u.email) return sendJson(res, 400, { ok: false, error: 'no_email' });
    if (limited('a2code:' + u.email, 1, 55_000)) return sendJson(res, 429, { ok: false, error: 'too_soon', retryAfter: 55 });
    if (limited('a2code-ip:' + (ipOf(req) || '?'), 20, 3600_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests', retryAfter: 600 });
    if (limited('a2code-day:' + u.email, 30, 24 * 3600_000)) return sendJson(res, 429, { ok: false, error: 'too_many_codes', retryAfter: 3600 });
    const code = String(crypto.randomInt(100000, 1000000));
    await db().query('INSERT INTO admin_codes (email, code_hash, expires_at, attempts, last_sent_at) VALUES (?,?,?,0,?) ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), expires_at = VALUES(expires_at), attempts = 0, last_sent_at = VALUES(last_sent_at)', [u.email, hashCode(u.email, code), new Date(Date.now() + 10 * 60_000), new Date()]);
    try {
      await mail().sendMail({ from: `"萝卜喵公益服" <${MAIL.user}>`, to: u.email, subject: '【萝卜喵公益服】管理后台二次验证码', text: `你的管理后台二次验证码是 ${code}，10 分钟内有效。\n\n—— 萝卜喵公益服 · 卫戍协议：盟约`, html: codeMailHtml(code) });
    } catch { return sendJson(res, 502, { ok: false, error: 'mail_failed' }); }
    return sendJson(res, 200, { ok: true, cooldown: 60, masked: u.email.replace(/^(.).*(@.*)$/, '$1***$2') });
  }
  if (method === 'POST' && pathname === '/api/admin2/login-code') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'login_required' });
    if (!u.role || u.role === 'player') return sendJson(res, 403, { ok: false, error: 'not_admin' });
    const body = await readBody(req, 8 * 1024);
    const code = String(body.code || '').trim();
    if (!/^[0-9]{6}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'invalid_code' });
    const [cr] = await db().query('SELECT code_hash, expires_at, attempts FROM admin_codes WHERE email = ?', [u.email]);
    const rec = cr[0];
    if (!rec) return sendJson(res, 400, { ok: false, error: 'code_required' });
    if (new Date(rec.expires_at).getTime() < Date.now()) return sendJson(res, 400, { ok: false, error: 'code_expired' });
    if (Number(rec.attempts) >= 5) return sendJson(res, 429, { ok: false, error: 'code_attempts' });
    if (rec.code_hash !== hashCode(u.email, code)) { await db().query('UPDATE admin_codes SET attempts = attempts + 1 WHERE email = ?', [u.email]); return sendJson(res, 400, { ok: false, error: 'code_wrong' }); }
    // 先建会话再消费验证码：会话写入失败时验证码仍可用，避免白白作废
    const sid = parseCookies(req)[SESSION_COOKIE] || '';
    const token = newSid();
    await db().query('INSERT INTO admin_sessions (token, admin_id, expires_at, sid) VALUES (?,?,?,?)', [token, u.id, new Date(Date.now() + 12 * 3600_000), sid]);
    await db().query('DELETE FROM admin_codes WHERE email = ?', [u.email]);
    await audit({ id: u.id, email: u.email }, 'login-code', u.id, u.role, ipOf(req));
    return sendJson(res, 200, { ok: true, token, admin: { id: u.id, email: u.email, nickname: u.nickname, tag: u.tag, role: u.role } });
  }
  // ---------------- 游戏内管理员工具：一次性授权码（本服，2026-10-31）----------------
  // 设计目标：游戏内那个刷干员 / 刷装备的面板，**不能只靠"登录了管理员账号"就长期有效**。
  // 维护者要求：几小时过期一次，过期后必须回管理后台取新的码才能继续用。
  //
  // 流程（码只能在后台生成，游戏页拿不到）：
  //   1) 后台已登录 → POST /api/admin2/tool-code  → 拿到 6 位码（后台页面显示给你）
  //   2) 游戏页 → POST /api/admintool/exchange { email, code }
  //              → 验证码正确且账号 role 为 owner/admin → 下发 adminToken（4 小时）
  //   3) 节点 net.js 验签该 token → session.admin → 放行 g.test
  //
  // 为什么码要有 TTL（10 分钟）而 token 是 4 小时：码是「一次授权动作」，token 是「这段工作时间内有效」。
  // 码用过即删，避免被重复兑换。
  if (method === 'POST' && pathname === '/api/admin2/tool-code') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'login_required' });
    if (u.role !== 'owner' && u.role !== 'admin') return sendJson(res, 403, { ok: false, error: 'not_admin' });
    // 最高管理员恒有；普通 admin 要在「权限设置」里勾了 tools.game 才行
    if (u.role !== 'owner' && !(await adminHasPerm(u.id, 'tools.game'))) {
      return sendJson(res, 403, { ok: false, error: 'no_perm' });
    }
    if (limited('toolcode:' + (ipOf(req) || '?'), 20, 3600_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    const code = String(crypto.randomInt(100000, 1000000));
    const key = 'tool_code:' + String(u.email || '').toLowerCase();
    // 复用 admin_settings 的 k/v 表：只存哈希 + 过期时间，不新增表
    const val = JSON.stringify({ h: hashCode(key, code), exp: Date.now() + 10 * 60_000, uid: u.id });
    await db().query('INSERT INTO admin_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, val]);
    await audit({ id: u.id, email: u.email }, 'tool-code-issue', u.id, u.role, ipOf(req));
    return sendJson(res, 200, { ok: true, code, minutes: 10, hours: 4, note: '在游戏内点左上角延迟胶囊，输入这个码' });
  }
  if (method === 'POST' && pathname === '/api/admintool/exchange') {
    // ⚠ 路径不能挂在 /api/admin/ 下：那个前缀在本文件上方有「仅本机 IP」+「Bearer 鉴权」两道旧守卫，
    //    游戏页从公网访问会被直接 403/401。
    if (limited('toolex:' + (ipOf(req) || '?'), 30, 3600_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    const body = await readBody(req, 8 * 1024);
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    if (!email || !/^[0-9]{6}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'invalid' });
    const key = 'tool_code:' + email;
    const [rows] = await db().query('SELECT v FROM admin_settings WHERE k = ?', [key]);
    const rec = rows[0] ? JSON.parse(rows[0].v) : null;
    if (!rec || Number(rec.exp) < Date.now()) return sendJson(res, 400, { ok: false, error: 'code_expired' });
    if (rec.h !== hashCode(key, code)) return sendJson(res, 400, { ok: false, error: 'code_wrong' });
    // 角色仍以账号表为准：验证码只证明「后台已登录并发过码」，不替代角色判定
    const [acc] = await db().query('SELECT id, email, nickname, tag, role, disabled, deleted_at FROM accounts WHERE email = ?', [email]);
    const a = acc[0];
    if (!a || a.disabled || a.deleted_at || (a.role !== 'owner' && a.role !== 'admin')) {
      return sendJson(res, 403, { ok: false, error: 'not_admin' });
    }
    // 权限吊销后即使手里还有旧码也不能用：最高管理员恒有，普通 admin 要 tools.game
    if (a.role !== 'owner' && !(await adminHasPerm(a.id, 'tools.game'))) {
      await db().query('DELETE FROM admin_settings WHERE k = ?', [key]);
      return sendJson(res, 403, { ok: false, error: 'no_perm' });
    }
    await db().query('DELETE FROM admin_settings WHERE k = ?', [key]);   // 一次性
    await audit({ id: a.id, email: a.email }, 'tool-code-redeem', a.id, a.role, ipOf(req));
    // adminToken 有效期 4 小时（adminTokenFor 写死 12 小时，这里单独签一个短期的）
    // iat：签发时间。配合「吊销时间点」实现退出授权 —— 早于吊销点的令牌一律作废。
    const payload = Buffer.from(JSON.stringify({ v: 1, typ: 'admin', uid: a.id, role: a.role, iat: Date.now(), exp: Date.now() + 4 * 3600_000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', watchSecret()).update(payload).digest('base64url');
    return sendJson(res, 200, { ok: true, adminToken: payload + '.' + sig, hours: 4, role: a.role });
  }
  // 吊销验码令牌（游戏内「退出授权」按钮调用）。
  // 令牌是无状态 HMAC，服务端无法单独作废某一枚，所以记一个「吊销时间点」：
  // 早于这个时刻签发的 admin 令牌一律失效（节点侧 verifyAdminToken 会比对 iat）。
  // 存在 admin_settings 表里，键固定为 tool_revoke_at，所有节点共用。
  if (method === 'POST' && pathname === '/api/admintool/revoke') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'login_required' });
    if (u.role !== 'owner' && u.role !== 'admin') return sendJson(res, 403, { ok: false, error: 'not_admin' });
    const at = Date.now();
    await db().query('INSERT INTO admin_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['tool_revoke_at', String(at)]);
    // 同时写文件：节点只读 .secrets 下的文件，不查数据库（见 server/adminAuth.js）
    try {
      const fsp = require('node:fs');
      const pth = require('node:path');
      const root = process.env.SP_ROOT || pth.resolve(__dirname, '..');
      fsp.writeFileSync(pth.join(root, '.secrets', 'admin-revoke-at'), String(at), 'utf8');
    } catch (e) { console.error('[revoke] 写文件失败', e && e.message); }
    await audit({ id: u.id, email: u.email }, 'tool-code-revoke', u.id, u.role, ipOf(req));
    return sendJson(res, 200, { ok: true, revokedAt: at });
  }
  // 验证码状态查询：后台生成码之后轮询它，用掉就立刻显示「已使用」并禁用。
  // 服务端在 exchange 里已经 DELETE 了记录，这里只读一次判断还在不在。
  if (method === 'GET' && pathname === '/api/admin2/tool-code-status') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'login_required' });
    if (u.role !== 'owner' && u.role !== 'admin') return sendJson(res, 403, { ok: false, error: 'not_admin' });
    const key = 'tool_code:' + String(u.email || '').toLowerCase();
    const [rows] = await db().query('SELECT v FROM admin_settings WHERE k = ?', [key]);
    if (!rows[0]) return sendJson(res, 200, { ok: true, used: true, remaining: 0 });
    let rec = null;
    try { rec = JSON.parse(rows[0].v); } catch { rec = null; }
    const left = rec ? Math.max(0, Number(rec.exp) - Date.now()) : 0;
    return sendJson(res, 200, { ok: true, used: false, remaining: left, expired: left <= 0 });
  }

  if (method === 'POST' && pathname === '/api/admin2/login') {
    const body = await readBody(req, 8 * 1024);
    const email = String(body.email || '').trim().toLowerCase();
    if (limited('admin2:' + (ipOf(req) || '?'), 10, 60_000)) return sendJson(res, 429, { ok: false, error: 'too_many_requests' });
    const [rows] = await db().query('SELECT id, email, nickname, tag, pass_hash, role, disabled FROM accounts WHERE email = ? AND deleted_at IS NULL', [email]);
    const a = rows[0];
    const failKey = 'a2fail:' + email + ':' + (ipOf(req) || '?');
    if ((FAILS.get(failKey) || 0) >= 5) return sendJson(res, 429, { ok: false, error: 'locked' });
    if (!a || a.disabled || a.role === 'player' || !verifyPassword(String(body.password || ''), a.pass_hash)) {
      FAILS.set(failKey, (FAILS.get(failKey) || 0) + 1);
      setTimeout(() => FAILS.delete(failKey), 5 * 60_000);
      return sendJson(res, 401, { ok: false, error: 'bad_credentials' });
    }
    FAILS.delete(failKey);
    // 非常用设备识别：新设备登录时邮件通知所有最高管理员
    try {
      const ua = String(req.headers['user-agent'] || '').slice(0, 255);
      const lang = String(req.headers['accept-language'] || '');
      const dev = crypto.createHash('sha256').update(ua + '|' + lang).digest('hex');
      const [known] = await db().query('SELECT 1 FROM admin_devices WHERE account_id = ? AND device = ?', [a.id, dev]);
      if (!known[0]) {
        await db().query('INSERT IGNORE INTO admin_devices (account_id, device, ua, ip) VALUES (?,?,?,?)', [a.id, dev, ua, ipOf(req)]);
        const [owners] = await db().query("SELECT email FROM accounts WHERE role = 'owner' AND email IS NOT NULL AND deleted_at IS NULL");
        const subject = '【萝卜喵公益服】管理员账号在新设备登录';
        const text = '管理员账号 ' + a.email + '（' + (a.nickname || '') + '#' + (a.tag || '') + '）于新设备登录。\nIP: ' + ipOf(req) + '\nUA: ' + ua + '\n如非本人操作，请立即到后台重置密码或收回权限。\n\n—— 萝卜喵公益服 · 卫戍协议：盟约';
        for (const o of owners) {
          if (!o.email) continue;
          try { await mail().sendMail({ from: `"萝卜喵公益服" <${MAIL.user}>`, to: o.email, subject, text }); } catch { /* 忽略 */ }
        }
        await audit({ id: a.id, email: a.email }, 'new-device', a.id, ipOf(req), ipOf(req));
      }
    } catch { /* 设备识别失败不影响登录 */ }
    const token = newSid();
    await db().query('INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?,?,?)', [token, a.id, new Date(Date.now() + 12 * 3600_000)]);
    await audit({ id: a.id, email: a.email }, 'login', a.id, a.role, ipOf(req));
    return sendJson(res, 200, { ok: true, token, admin: { id: a.id, email: a.email, nickname: a.nickname, tag: a.tag, role: a.role } });
  }
  if (pathname.startsWith('/api/admin2/') && pathname !== '/api/admin2/login') {
    // Read the small POST body before the awaited admin-session lookup: on some
    // Node versions the request stream has already flushed by the time the
    // route handler queries MySQL, which made game-gate/create-room read '{}'.
    const earlyBody = method === 'POST' && (
      pathname === '/api/admin2/game-gate' ||
      pathname === '/api/admin2/create-room' ||
      pathname === '/api/admin2/watch-token'
    ) ? readBody(req, 8 * 1024).catch(() => null) : null;
    const auth = String(req.headers.authorization || '');
    const bm = /^Bearer\s+([A-Za-z0-9_-]{20,64})$/.exec(auth);
    const [sess] = bm ? await db().query('SELECT s.admin_id, s.expires_at, s.sid, a.email, a.nickname, a.tag, a.role, a.disabled FROM admin_sessions s JOIN accounts a ON a.id = s.admin_id WHERE s.token = ?', [bm[1]]) : [[]];
    const me2 = sess[0];
    if (!me2 || me2.disabled || me2.role === 'player' || new Date(me2.expires_at).getTime() < Date.now()) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (!me2.sid || parseCookies(req)[SESSION_COOKIE] !== me2.sid) return sendJson(res, 401, { ok: false, error: 'session_mismatch' });
    const isOwner = me2.role === 'owner';
    me2.perms = isOwner ? ['*'] : await getAdminPerms();
    if (method === 'GET' && pathname === '/api/admin2/me') return sendJson(res, 200, { ok: true, admin: { id: me2.admin_id, email: me2.email, nickname: me2.nickname, tag: me2.tag, role: me2.role }, perms: me2.perms });
    if (method === 'POST' && pathname === '/api/admin2/watch-token') {
      // 独立权限 rooms.watch：隐身观战能看到房间里的一切（包括玩家名字与会话），
      // 但不占观战席、不算房间成员，属于「只读但范围最大」的能力，单独授权。
      if (!adminCan(me2, 'rooms.watch')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      let code = '';
      try { const b = earlyBody ? await earlyBody : null; code = String(b && b.code || '').toUpperCase(); } catch { /* bad body */ }
      if (!code) {
        try { code = String(new URL(req.url, 'http://x').searchParams.get('code') || '').toUpperCase(); } catch { /* ignore */ }
      }
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'bad_code' });
      const payload = Buffer.from(JSON.stringify({ c: code, exp: Date.now() + 30 * 60 * 1000 })).toString('base64url');
      const sig = crypto.createHmac('sha256', watchSecret()).update(payload).digest('base64url');
      return sendJson(res, 200, { ok: true, token: payload + '.' + sig });
    }
    if (method === 'GET' && pathname === '/api/admin2/game-gate') {
      if (!adminCan(me2, 'rooms.maintenance')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      try {
        const j = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'content', 'game-gate.json'), 'utf8'));
        return sendJson(res, 200, { ok: true, start: j.start !== false, match: j.match !== false, reason: String(j.reason || '') });
      } catch { return sendJson(res, 200, { ok: true, start: true, match: true, reason: '' }); }
    }
    if (method === 'POST' && pathname === '/api/admin2/game-gate') {
      if (!adminCan(me2, 'rooms.maintenance')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      let b = null;
      try { b = earlyBody ? await earlyBody : null; } catch { /* bad body */ }
      if (!b || typeof b.start !== 'boolean' || typeof b.match !== 'boolean') {
        try {
          const q = new URL(req.url, 'http://x').searchParams;
          if (q.has('start') && q.has('match')) b = { start: q.get('start') === '1', match: q.get('match') === '1' };
        } catch { /* ignore */ }
      }
      if (!b || typeof b.start !== 'boolean' || typeof b.match !== 'boolean') return sendJson(res, 400, { ok: false, error: 'bad_gate' });
      const doc = { start: b.start, match: b.match, reason: String(b.reason || '').slice(0, 200), updatedAt: Date.now() };
      try { fs.writeFileSync(require('node:path').join(__dirname, '..', 'content', 'game-gate.json'), JSON.stringify(doc, null, 2), 'utf8'); } catch { return sendJson(res, 500, { ok: false, error: 'write_failed' }); }
      await audit({ id: me2.admin_id, email: me2.email }, 'game-gate', null, `start=${doc.start} match=${doc.match}`, ipOf(req));
      return sendJson(res, 200, { ok: true, ...doc });
    }
    if (method === 'GET' && pathname === '/api/admin2/create-room') {
      if (!adminCan(me2, 'rooms.maintenance')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      try {
        const p = require('node:path');
        let enabled = true;
        for (let n = 1; n <= 30; n++) {
          try {
            const j = JSON.parse(fs.readFileSync(p.join(__dirname, '..', `node-${n}`, 'data', 'create-room.json'), 'utf8'));
            if (j.enabled === false) enabled = false;
          } catch { /* a missing node file means the default: enabled */ }
        }
        return sendJson(res, 200, { ok: true, enabled });
      } catch { return sendJson(res, 200, { ok: true, enabled: true }); }
    }
    if (method === 'POST' && pathname === '/api/admin2/create-room') {
      if (!adminCan(me2, 'rooms.maintenance')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      let b = null;
      try { b = earlyBody ? await earlyBody : null; } catch { /* bad body */ }
      if (!b || typeof b.enabled !== 'boolean') {
        try {
          const q = new URL(req.url, 'http://x').searchParams;
          if (q.has('enabled')) b = { enabled: q.get('enabled') === '1' };
        } catch { /* ignore */ }
      }
      if (!b || typeof b.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'bad_request' });
      const doc = { enabled: b.enabled, updatedAt: Date.now() };
      try {
        const p = require('node:path');
        for (let n = 1; n <= 30; n++) {
          fs.mkdirSync(p.join(__dirname, '..', `node-${n}`, 'data'), { recursive: true });
          fs.writeFileSync(p.join(__dirname, '..', `node-${n}`, 'data', 'create-room.json'), JSON.stringify(doc, null, 2), 'utf8');
        }
      } catch { return sendJson(res, 500, { ok: false, error: 'write_failed' }); }
      await audit({ id: me2.admin_id, email: me2.email }, 'create-room', null, `enabled=${b.enabled}`, ipOf(req));
      return sendJson(res, 200, { ok: true, enabled: b.enabled });
    }
    if (method === 'POST' && pathname === '/api/admin2/logout') { await db().query('DELETE FROM admin_sessions WHERE token = ?', [bm[1]]); return sendJson(res, 200, { ok: true }); }
    if (method === 'GET' && pathname === '/api/admin2/permissions') {
      if (!isOwner) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      // presets / dangerous 一并给前端：权限页据此渲染「只读 / 客服 / 运维 / 全部」
      // 一键模板，并把危险项标出来（任何预设都不含它们，必须手勾）。
      return sendJson(res, 200, {
        ok: true,
        catalog: ADMIN_PERMISSIONS,
        current: await getAdminPerms(),
        presets: PERM_PRESETS.map((p) => ({ id: p.id, label: p.label, desc: p.desc, keys: expandPreset(p) })),
        dangerous: DANGEROUS_PERMS,
      });
    }
    if (method === 'POST' && pathname === '/api/admin2/permissions') {
      if (!isOwner) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const pb = await readBody(req, 4096);
      const list = await setAdminPerms(pb.perms);
      await audit({ id: me2.admin_id, email: me2.email }, 'set-admin-perms', null, list.join(','), ipOf(req));
      return sendJson(res, 200, { ok: true, perms: list });
    }
    const md = /^\/api\/admin2\/accounts\/([0-9]+)\/detail$/.exec(pathname);
    if (md && method === 'GET') {
      if (!adminCan(me2, 'accounts.view')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const id = Number(md[1]);
      const [rows] = await db().query('SELECT id, email, nickname, tag, role, disabled, deleted_at, created_at, last_login_at FROM accounts WHERE id = ?', [id]);
      const a = rows[0];
      if (!a) return sendJson(res, 404, { ok: false, error: 'not_found' });
      const [pf] = await db().query('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM user_prefs WHERE user_id = ?', [id]);
      const [ss] = await db().query('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND expires_at > NOW()', [id]);
      const [au] = await db().query('SELECT actor_email, action, target_id, detail, ip, at FROM admin_audit WHERE target_id = ? OR actor_id = ? ORDER BY id DESC LIMIT 10', [id, id]);
      return sendJson(res, 200, { ok: true, account: a, prefs: { domains: Number(pf[0].n), bytes: Number(pf[0].bytes) }, sessions: Number(ss[0].n), audit: au });
    }
    if (method === 'GET' && pathname === '/api/admin2/accounts') {
      if (!adminCan(me2, 'accounts.view')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const ua2 = new URL(req.url, 'http://x');
      const q = String(ua2.searchParams.get('q') || '').trim();
      const onlyDeleted = ua2.searchParams.get('deleted') === '1';
      if (onlyDeleted && !adminCan(me2, 'accounts.delete')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const like = '%' + q + '%';
      const [rows] = q
        ? await db().query('SELECT id, email, nickname, tag, role, disabled, deleted_at, created_at, last_login_at FROM accounts WHERE (email LIKE ? OR nickname LIKE ? OR tag LIKE ?)' + (onlyDeleted ? ' AND deleted_at IS NOT NULL' : '') + ' ORDER BY id DESC', [like, like, like])
        : await db().query('SELECT id, email, nickname, tag, role, disabled, deleted_at, created_at, last_login_at FROM accounts' + (onlyDeleted ? ' WHERE deleted_at IS NOT NULL' : '') + ' ORDER BY id DESC');
      return sendJson(res, 200, { ok: true, accounts: rows });
    }
    const mr = /^\/api\/admin2\/accounts\/([0-9]+)\/(role|disabled|password|delete|restore|nickname)$/.exec(pathname);
    if (mr && method === 'POST') {
      const id = Number(mr[1]);
      const body = await readBody(req, 8 * 1024);
      const RANK = { player: 0, moderator: 2, admin: 2, owner: 3 };
      const myRank = RANK[me2.role] || 0;
      const [tgt] = await db().query('SELECT id, role FROM accounts WHERE id = ?', [id]);
      const target = tgt[0];
      if (!target) return sendJson(res, 404, { ok: false, error: 'not_found' });
      const tgtRank = RANK[target.role] || 0;
      // 只能操作比自己等级低的账号；同级或更高一律拒绝
      if (tgtRank >= myRank) return sendJson(res, 403, { ok: false, error: 'rank_denied' });
      if (mr[2] === 'nickname') {
        if (!adminCan(me2, 'accounts.rename')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
        const nick = String(body.nickname || '').trim();
        const bad = checkNickname(nick);
        if (bad) return sendJson(res, 400, { ok: false, ...bad });
        const tag = freshTag();
        await db().query('UPDATE accounts SET nickname = ?, name = ?, tag = ? WHERE id = ?', [nick, nick, tag, id]);
        await audit({ id: me2.admin_id, email: me2.email }, 'set-nickname', id, nick, ipOf(req));
        return sendJson(res, 200, { ok: true, id, nickname: nick, tag });
      }
      if (mr[2] === 'role') {
        if (!adminCan(me2, 'accounts.role')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
        const role = ['player', 'admin', 'owner'].includes(body.role) ? body.role : 'player';
        const newRank = RANK[role];
        // 不能授予与自己同级或更高的权限
        if (newRank >= myRank) return sendJson(res, 403, { ok: false, error: 'rank_denied' });
        await db().query('UPDATE accounts SET role = ? WHERE id = ?', [role, id]);
        if (role === 'player') await db().query('DELETE FROM admin_sessions WHERE admin_id = ?', [id]);
        await audit({ id: me2.admin_id, email: me2.email }, 'set-role', id, role, ipOf(req));
        return sendJson(res, 200, { ok: true, id, role });
      }
      if (mr[2] === 'disabled') {
        if (!adminCan(me2, 'accounts.ban')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
        const disabled = body.disabled === true ? 1 : 0;
        await db().query('UPDATE accounts SET disabled = ? WHERE id = ?', [disabled, id]);
        if (disabled) await db().query('DELETE FROM user_sessions WHERE user_id = ?', [id]);
        await audit({ id: me2.admin_id, email: me2.email }, disabled ? 'disable' : 'enable', id, null, ipOf(req));
        return sendJson(res, 200, { ok: true, id, disabled: !!disabled });
      }
      if (mr[2] === 'restore') {
        if (!adminCan(me2, 'accounts.delete')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
        await db().query('UPDATE accounts SET deleted_at = NULL WHERE id = ?', [id]);
        await audit({ id: me2.admin_id, email: me2.email }, 'restore-account', id, null, ipOf(req));
        return sendJson(res, 200, { ok: true, id });
      }
      if (mr[2] === 'delete') {
        if (!adminCan(me2, 'accounts.delete')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
        await db().query('DELETE FROM user_sessions WHERE user_id = ?', [id]);
        await db().query('DELETE FROM user_prefs WHERE user_id = ?', [id]);
        await db().query('DELETE FROM admin_sessions WHERE admin_id = ?', [id]);
        await db().query('UPDATE accounts SET deleted_at = NOW() WHERE id = ?', [id]);
        await audit({ id: me2.admin_id, email: me2.email }, 'delete-account', id, null, ipOf(req));
        return sendJson(res, 200, { ok: true, id });
      }
      if (!adminCan(me2, 'accounts.resetpw')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const pw = String(body.password || '');
      if (pw.length < 8) return sendJson(res, 400, { ok: false, error: 'invalid_password' });
      await db().query('UPDATE accounts SET pass_hash = ? WHERE id = ?', [hashPassword(pw), id]);
      await db().query('DELETE FROM user_sessions WHERE user_id = ?', [id]);
      await audit({ id: me2.admin_id, email: me2.email }, 'reset-password', id, null, ipOf(req));
      return sendJson(res, 200, { ok: true, id });
    }
  }

  // ---------------- 审计与节点控制（管理员）----------------
  if (pathname.startsWith('/api/admin2/audit') || pathname.startsWith('/api/admin2/nodes') || pathname.startsWith('/api/admin2/node/') || pathname.startsWith('/api/admin2/storage') || pathname.startsWith('/api/admin2/rooms')) {
    const auth = String(req.headers.authorization || '');
    const bm = /^Bearer\s+([A-Za-z0-9_-]{20,64})$/.exec(auth);
    const [sess] = bm ? await db().query('SELECT s.admin_id, s.expires_at, a.email, a.role, a.disabled FROM admin_sessions s JOIN accounts a ON a.id = s.admin_id WHERE s.token = ?', [bm[1]]) : [[]];
    const me3 = sess[0];
    if (!me3 || me3.disabled || me3.role === 'player' || new Date(me3.expires_at).getTime() < Date.now()) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    me3.perms = me3.role === 'owner' ? ['*'] : await getAdminPerms();
    if (method === 'GET' && pathname === '/api/admin2/storage') {
      if (!adminCan(me3, 'storage.view')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const [rows] = await db().query('SELECT u.id, u.email, u.nickname, u.tag, COUNT(p.domain) AS domains, COALESCE(SUM(LENGTH(p.payload)),0) AS bytes FROM user_prefs p JOIN accounts u ON u.id = p.user_id GROUP BY u.id ORDER BY bytes DESC LIMIT 20');
      const [tot] = await db().query('SELECT COUNT(*) AS users, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM user_prefs');
      return sendJson(res, 200, { ok: true, rows, total: { users: Number(tot[0].users), bytes: Number(tot[0].bytes) } });
    }
    if (method === 'GET' && pathname === '/api/admin2/audit') {
      if (!adminCan(me3, 'audit.view')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const u0 = new URL(req.url, 'http://x');
      const q = String(u0.searchParams.get('q') || '').trim();
      const action = String(u0.searchParams.get('action') || '').trim();
      const wantCsv = u0.searchParams.get('format') === 'csv';
      if (wantCsv && !adminCan(me3, 'audit.export')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const where = [];
      const args = [];
      if (q) { where.push('(actor_email LIKE ? OR detail LIKE ? OR ip LIKE ?)'); args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
      if (action) { where.push('action = ?'); args.push(action); }
      const sql = 'SELECT id, actor_email, action, target_id, detail, ip, at FROM admin_audit'
        + (where.length ? ' WHERE ' + where.join(' AND ') : '')
        + ' ORDER BY id DESC LIMIT 500';
      const [rows] = await db().query(sql, args);
      if (wantCsv) {
        const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const head = ['id', 'time', 'actor', 'action', 'target', 'detail', 'ip'].map(esc).join(',');
        const body = rows.map((r) => [r.id, String(r.at || ''), r.actor_email || '', r.action, r.target_id || '', r.detail || '', r.ip || ''].map(esc).join(',')).join('\r\n');
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="admin-audit.csv"', 'cache-control': 'no-store' });
        return res.end('\uFEFF' + head + '\r\n' + body);
      }
      return sendJson(res, 200, { ok: true, logs: rows });
    }
    if (method === 'GET' && pathname === '/api/admin2/nodes') {
      if (!adminCan(me3, 'nodes.view')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      try {
        const r = await fetch('http://127.0.0.1:3090/api/node-status');
        const j = await r.json();
        return sendJson(res, 200, { ok: true, ...j });
      } catch { return sendJson(res, 502, { ok: false, error: 'unavailable' }); }
    }
    if (method === 'GET' && pathname === '/api/admin2/rooms') {
      if (!adminCan(me3, 'rooms.view')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      try {
        const p = require('node:path').join(__dirname, '..', 'content', 'rooms.json');
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return sendJson(res, 200, { ok: true, at: data.at || 0, nodes: data.nodes || [] });
      } catch {
        const nodes = (roomDirProvider ? roomDirProvider() : []).map((x) => ({ n: x.n, at: x.at, rooms: (x.codes || []).map((code) => ({ code })) }));
        return sendJson(res, 200, { ok: true, at: Date.now(), nodes });
      }
    }
    // 关闭任意房间（本服新增）：{ code, node? }
    //
    // 房间归某个节点所有，其它节点不认识这个房间号，所以必须直接打「房间所在的那台」。
    // node 由前端从 /api/admin2/rooms 的列表里带上；没带就去 rooms.json 里找。
    // 节点侧用 .secrets/watch-secret 的 HMAC 认人（server/http/routes.js /admin/room/close）。
    if (method === 'POST' && pathname === '/api/admin2/rooms/close') {
      if (!adminCan(me3, 'rooms.close')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const body = await readBody(req, 4096).catch(() => ({}));
      const code = String(body && body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'bad_code' });
      let nodeN = Number(body && body.node);
      if (!(nodeN >= 1 && nodeN <= 30)) {
        // 没给节点号就从房间目录里找（同一房间号只会属于一台节点）
        try {
          const p = require('node:path').join(__dirname, '..', 'content', 'rooms.json');
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const n of data.nodes || []) {
            if ((n.rooms || []).some((r) => String(r && r.code).toUpperCase() === code)) { nodeN = Number(n.n); break; }
          }
        } catch { /* 目录缺了就只能靠前端传的 node */ }
      }
      if (!(nodeN >= 1 && nodeN <= 30)) return sendJson(res, 404, { ok: false, error: 'room_not_found' });
      let secret = '';
      try { secret = fs.readFileSync(require('node:path').join(__dirname, '..', '.secrets', 'watch-secret'), 'utf8').trim(); } catch { /* 下面会返回 503 */ }
      if (!secret) return sendJson(res, 503, { ok: false, error: 'no_secret' });
      const exp = Date.now() + 60_000;
      const sig = require('node:crypto').createHmac('sha256', secret).update(`${code}.${exp}`).digest('base64url');
      const payload = JSON.stringify({ code, exp });
      const out = await new Promise((resolve) => {
        const req2 = require('node:http').request({
          host: '127.0.0.1', port: 3000 + nodeN, path: '/admin/room/close', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-sp-admin-sig': sig },
          timeout: 8000,
        }, (r2) => {
          let b = '';
          r2.on('data', (c) => { b += c; });
          r2.on('end', () => { try { resolve({ status: r2.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: r2.statusCode, body: { ok: false, error: 'bad_response' } }); } });
        });
        req2.on('error', (e) => resolve({ status: 0, body: { ok: false, error: String(e && e.code || e) } }));
        req2.on('timeout', () => { req2.destroy(); resolve({ status: 0, body: { ok: false, error: 'timeout' } }); });
        req2.write(payload);
        req2.end();
      });
      if (out.body && out.body.ok) {
        await audit({ id: me3.admin_id, email: me3.email }, 'close-room', code, 'node-' + nodeN, ipOf(req));
        return sendJson(res, 200, { ok: true, code, node: nodeN, humans: out.body.humans, running: out.body.running });
      }
      const err = (out.body && out.body.error) || 'close_failed';
      const status = err === 'no_room' ? 404 : out.status >= 400 ? out.status : 502;
      return sendJson(res, status, { ok: false, error: err, node: nodeN });
    }
    // 结束房间里当前这一局，但**保留房间**（维护者 2026-10-29 要求）：
    // 玩家不会被移出同盟，只是这一局没了，可以直接重新开局。
    // 鉴权、找节点、签名与 close 完全一致，只是打 /admin/room/abort、审计动作不同。
    if (method === 'POST' && pathname === '/api/admin2/rooms/abort') {
      // 独立权限 rooms.abort：结束对局会作废玩家进度，但不销毁房间，
      // 比「关闭房间」轻一档，允许单独授予。
      if (!adminCan(me3, 'rooms.abort')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const body = await readBody(req, 4096).catch(() => ({}));
      const code = String(body && body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'bad_code' });
      let nodeN = Number(body && body.node);
      if (!(nodeN >= 1 && nodeN <= 30)) {
        try {
          const p = require('node:path').join(__dirname, '..', 'content', 'rooms.json');
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const n of data.nodes || []) {
            if ((n.rooms || []).some((r) => String(r && r.code).toUpperCase() === code)) { nodeN = Number(n.n); break; }
          }
        } catch { /* 目录缺了就只能靠前端传的 node */ }
      }
      if (!(nodeN >= 1 && nodeN <= 30)) return sendJson(res, 404, { ok: false, error: 'room_not_found' });
      let secret = '';
      try { secret = fs.readFileSync(require('node:path').join(__dirname, '..', '.secrets', 'watch-secret'), 'utf8').trim(); } catch { /* 下面会返回 503 */ }
      if (!secret) return sendJson(res, 503, { ok: false, error: 'no_secret' });
      const exp = Date.now() + 60_000;
      const sig = require('node:crypto').createHmac('sha256', secret).update(`${code}.${exp}`).digest('base64url');
      const payload = JSON.stringify({ code, exp });
      const out = await new Promise((resolve) => {
        const req2 = require('node:http').request({
          host: '127.0.0.1', port: 3000 + nodeN, path: '/admin/room/abort', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-sp-admin-sig': sig },
          timeout: 8000,
        }, (r2) => {
          let b = '';
          r2.on('data', (c) => { b += c; });
          r2.on('end', () => { try { resolve({ status: r2.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: r2.statusCode, body: { ok: false, error: 'bad_response' } }); } });
        });
        req2.on('error', (e) => resolve({ status: 0, body: { ok: false, error: String(e && e.code || e) } }));
        req2.on('timeout', () => { req2.destroy(); resolve({ status: 0, body: { ok: false, error: 'timeout' } }); });
        req2.write(payload);
        req2.end();
      });
      if (out.body && out.body.ok) {
        await audit({ id: me3.admin_id, email: me3.email }, 'abort-match', code, 'node-' + nodeN, ipOf(req));
        return sendJson(res, 200, { ok: true, code, node: nodeN, humans: out.body.humans, roomKept: true });
      }
      const err = (out.body && out.body.error) || 'abort_failed';
      const status = err === 'no_room' ? 404 : err === 'no_match' ? 409 : out.status >= 400 ? out.status : 502;
      return sendJson(res, status, { ok: false, error: err, node: nodeN });
    }
    const mn = /^\/api\/admin2\/node\/([0-9]{1,2})\/restart$/.exec(pathname);
    if (mn && method === 'POST') {
      if (!adminCan(me3, 'nodes.restart')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const n = Number(mn[1]);
      if (!(n >= 1 && n <= 30)) return sendJson(res, 400, { ok: false, error: 'bad_node' });
      try {
        const { execFile } = require('node:child_process');
        const fsx = require('node:fs');
        const pathMod = require('node:path');
        // pm2 不在 PATH 里时 execFile('pm2') 会 ENOENT —— 而 matchmaker 的 PATH 是空的
        // （由 pm2 启动的进程没有继承用户 PATH），所以这里显式定位 pm2：
        //   1) 「当前 node + pm2 的 bin 脚本」，完全不依赖 PATH；
        //   2) 退回 %APPDATA%\npm\pm2.cmd；
        //   3) 都找不到就把真实原因记进日志，绝不伪装成「没权限」。
        const npmDirs = [
          process.env.APPDATA && pathMod.join(process.env.APPDATA, 'npm'),
        ].filter(Boolean);
        const pm2BinJs = npmDirs
          .map((d) => pathMod.join(d, 'node_modules', 'pm2', 'bin', 'pm2'))
          .find((f) => { try { return fsx.existsSync(f); } catch { return false; } });
        const pm2Cmd = npmDirs
          .map((d) => pathMod.join(d, 'pm2.cmd'))
          .find((f) => { try { return fsx.existsSync(f); } catch { return false; } });
        let cmd, args;
        if (pm2BinJs) {
          cmd = process.execPath;
          args = [pm2BinJs, 'restart', 'node-' + n, '--update-env'];
        } else if (pm2Cmd) {
          cmd = pm2Cmd;
          args = ['restart', 'node-' + n, '--update-env'];
        } else {
          console.error('[admin2] restart-node: 找不到 pm2，PATH=' + String(process.env.PATH || ''));
          return sendJson(res, 500, { ok: false, error: 'pm2_not_found' });
        }
        await new Promise((resolve, reject) => {
          execFile(cmd, args, { windowsHide: true, env: { ...process.env, PM2_HOME: process.env.PM2_HOME || pathMod.join(process.env.APPDATA || '', 'pm2') } },
            (e, so, se) => (e ? reject(Object.assign(e, { stderrOut: String(se || ''), cmdUsed: cmd })) : resolve()));
        });
        await audit({ id: me3.admin_id, email: me3.email }, 'restart-node', n, 'node-' + n, ipOf(req));
        return sendJson(res, 200, { ok: true, node: n });
      } catch (e) {
        console.error('[admin2] restart-node failed:', e && ((e.cmdUsed || '') + ' ' + e.message + ' ' + (e.stderrOut || '')));
        return sendJson(res, 500, { ok: false, error: 'restart_failed', detail: String((e && (e.stderrOut || (e.cmdUsed || '') + ' ' + e.message)) || '').slice(0, 300) });
      }
    }
  }
  // ---------------- 服务器设置代理（转发本机 3080）----------------
  //
  // 权限按【管理后台的页签】划分，一个页签一项 —— 本路由整体属于「服务器设置」页签，
  // 所以仍然只用 dash.settings 一项把关（不再按子路径拆，拆了就和页签对不上）。
  if (pathname.startsWith('/api/admin2/dash/') && (method === 'GET' || method === 'POST')) {
    const auth = String(req.headers.authorization || '');
    const bm = /^Bearer\s+([A-Za-z0-9_-]{20,64})$/.exec(auth);
    const [sess] = bm ? await db().query('SELECT s.admin_id, s.expires_at, a.email, a.role, a.disabled FROM admin_sessions s JOIN accounts a ON a.id = s.admin_id WHERE s.token = ?', [bm[1]]) : [[]];
    const me4 = sess[0];
    if (!me4 || me4.disabled || me4.role === 'player' || new Date(me4.expires_at).getTime() < Date.now()) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    me4.perms = me4.role === 'owner' ? ['*'] : await getAdminPerms();
    if (!adminCan(me4, 'dash.settings')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    const sub = pathname.slice('/api/admin2/dash'.length);
    if (!/^\/(status|create-room|room-ttl|game-gate|announcement|announcements|update|update\/run|protection|protection\/action|logs|nginx|action|health|history)(\?.*)?$/.test(sub + (new URL(req.url, 'http://x').search || ''))) return sendJson(res, 400, { ok: false, error: 'bad_path' });
    try {
      const init = { method, headers: { 'content-type': 'application/json' } };
      if (method === 'POST') init.body = await new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b || '{}')); });
      const r = await fetch('http://127.0.0.1:3080/api' + sub + (new URL(req.url, 'http://x').search || ''), init);
      const text = await r.text();
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(text);
    } catch { return sendJson(res, 502, { ok: false, error: 'dashboard_unavailable' }); }
  }
  // 一键重置账号云端数据
  if (method === 'POST' && pathname === '/api/prefs/reset') {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    await db().query('DELETE FROM user_prefs WHERE user_id = ?', [u.id]);
    await audit({ id: u.id, email: u.email }, 'self-reset-prefs', u.id, null, ipOf(req));
    return sendJson(res, 200, { ok: true });
  }
  if (pathname.startsWith('/api/prefs')) {
    const u = await currentUser(req);
    if (!u) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

    if (method === 'GET' && pathname === '/api/prefs') {
      const [rows] = await db().query('SELECT domain, payload, version, updated_at FROM user_prefs WHERE user_id = ?', [u.id]);
      const domains = {};
      for (const r of rows) domains[r.domain] = { payload: typeof r.payload === 'string' ? decodePrefPayload(r.payload) : r.payload, version: Number(r.version), updatedAt: r.updated_at };
      return sendJson(res, 200, { ok: true, domains });
    }

    // 合并必须在 /api/prefs/:domain 之前处理，否则 "merge" 会被当成域名 → 404
    if (method === 'POST' && pathname === '/api/prefs/merge') {
      if (limited('prefs-merge:' + u.id, 20, 60_000)) return sendJson(res, 429, { ok: false, error: 'too_many_writes' });
      const body = await readBody(req);
      const domains = body && typeof body.domains === 'object' && body.domains ? body.domains : {};
      const result = {};
      const isEmptyPayload = (v) => v == null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);
      for (const [domain, value] of Object.entries(domains)) {
        if (!DOMAINS.has(domain)) continue;
        const rawMerge = value && value.payload !== undefined ? value.payload : value;
        if (!validatePrefPayload(domain, rawMerge)) { result[domain] = { merged: false, reason: 'invalid' }; continue; }
        if (isEmptyPayload(rawMerge)) { result[domain] = { merged: false, reason: 'empty' }; continue; }
        const payload = JSON.stringify(rawMerge);
        if (payload.length > (domain === 'stats' ? STATS_LIMIT : DOMAIN_LIMIT)) { result[domain] = { merged: false, reason: 'too_large' }; continue; }
        const [rows] = await db().query('SELECT version FROM user_prefs WHERE user_id = ? AND domain = ?', [u.id, domain]);
        if (rows[0]) { result[domain] = { merged: false, reason: 'server_wins', version: Number(rows[0].version) }; continue; }
        await db().query('INSERT INTO user_prefs (user_id, domain, payload, version) VALUES (?,?,?,1)', [u.id, domain, payload]);
        result[domain] = { merged: true, version: 1 };
      }
      return sendJson(res, 200, { ok: true, result });
    }

    const m = /^\/api\/prefs\/([A-Za-z]+)$/.exec(pathname);
    if (m) {
      const domain = m[1];
      if (!DOMAINS.has(domain)) return sendJson(res, 404, { ok: false, error: 'unknown_domain' });
      if (method === 'GET') {
        const [rows] = await db().query('SELECT payload, version, updated_at FROM user_prefs WHERE user_id = ? AND domain = ?', [u.id, domain]);
        if (!rows[0]) return sendJson(res, 404, { ok: false, error: 'empty' });
        const r = rows[0];
        return sendJson(res, 200, { ok: true, payload: typeof r.payload === 'string' ? decodePrefPayload(r.payload) : r.payload, version: Number(r.version), updatedAt: r.updated_at });
      }
      if (method === 'PUT') {
        // 写入限流：正常 800ms 防抖最多约 75 次/分钟，这里放宽到 120 次/分钟防刷
        if (limited('prefs-put:' + u.id, 120, 60_000)) return sendJson(res, 429, { ok: false, error: 'too_many_writes' });
        const body = await readBody(req);
        if (!validatePrefPayload(domain, body.payload)) return sendJson(res, 400, { ok: false, error: 'invalid_payload' });
        const migrated = migratePrefPayload(domain, body.payload, body.schemaVer);
        const payload = JSON.stringify(migrated.payload ?? null);
        if (payload.length > (domain === 'stats' ? STATS_LIMIT : DOMAIN_LIMIT)) return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
        const base = Number(body.baseVersion || 0);
        const [rows] = await db().query('SELECT version FROM user_prefs WHERE user_id = ? AND domain = ?', [u.id, domain]);
        const cur = rows[0] ? Number(rows[0].version) : 0;
        if (cur > 0 && base !== cur) {
          const [now] = await db().query('SELECT payload, version, updated_at FROM user_prefs WHERE user_id = ? AND domain = ?', [u.id, domain]);
          return sendJson(res, 409, { ok: false, error: 'version_conflict', server: { payload: typeof now[0].payload === 'string' ? decodePrefPayload(now[0].payload) : now[0].payload, version: Number(now[0].version) } });
        }
        // 防误覆盖：调配条目大幅减少时要求显式确认
        if (domain === 'loadout' && cur > 0 && body.force !== true) {
          try {
            const [op] = await db().query('SELECT payload FROM user_prefs WHERE user_id = ? AND domain = ?', [u.id, domain]);
            const oldP = typeof op[0].payload === 'string' ? decodePrefPayload(op[0].payload) : op[0].payload;
            const oldN = Object.keys((oldP && oldP.entries) || {}).length;
            const newN = Object.keys((body.payload && body.payload.entries) || {}).length;
            if (oldN >= 4 && newN < Math.ceil(oldN / 2)) {
              return sendJson(res, 409, { ok: false, error: 'mass_removal_guard', server: { payload: oldP, version: cur } });
            }
          } catch { /* 忽略 */ }
        }
        if (cur === 0) {
          await db().query('INSERT INTO user_prefs (user_id, domain, payload, version) VALUES (?,?,?,1)', [u.id, domain, payload]);
          return sendJson(res, 200, { ok: true, version: 1 });
        }
        await db().query('UPDATE user_prefs SET payload = ?, version = version + 1 WHERE user_id = ? AND domain = ?', [payload, u.id, domain]);
        return sendJson(res, 200, { ok: true, version: cur + 1 });
      }
    }
  }

  return false;
}

module.exports = { handle, ensureSchema, currentUser, DOMAINS, codeMailHtml, adminGate, setRoomDirProvider };

/** 由 server.js 注入：返回 [{ n, codes, at }]，供后台 /api/admin2/rooms 展示。 */
let roomDirProvider = null;
function setRoomDirProvider(fn) { roomDirProvider = typeof fn === 'function' ? fn : null; }

// 页面级访问控制：只有已登录且非普通玩家的账号才能打开管理页面
async function adminGate(req) {
  try {
    const u = await currentUser(req);
    return !!(u && u.role && u.role !== 'player');
  } catch { return false; }
}
