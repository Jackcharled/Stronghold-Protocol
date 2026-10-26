// 「管理后台」按钮消失：不能只依赖 window.__SP_ACCOUNT_ROLE
//
// 玩家反馈：管理后台按钮不见了，怀疑被降级成普通玩家。
// 实查数据库 role 仍是 owner（id=1 武桐_Uton，disabled=0，deleted_at=null），
// /mm/api/auth/me 也正常返回 role=owner。
//
// 根因：installAdminEntry() 只读 window.__SP_ACCOUNT_ROLE —— 这个变量由
// account-title.js 的 render() 异步写入，一旦它没跑（或被清空），按钮就永远不出现。
//
// 修复：加入 currentRole()，先看变量；变量为空时主动 GET /mm/api/auth/me
// 拿真实角色并缓存，下一轮（1.5s 后）按钮就能正确出现。
//
//   node test/admin-button-visible.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const client = fs.readFileSync('matchmaker/public/client.js', 'utf8');

console.log('=== 按钮显示条件 ===\n');
check('仍要求在大厅（标题页不显示）', /const onTitle = !!document\.querySelector\('\.title-screen'\)/.test(client));
check('仍要求公告按钮存在', /const notice = document\.getElementById\('mm-notice-btn'\)/.test(client));
check('仍排除 role 为空 / player', /role === 'player'/.test(client));

console.log('\n=== 角色来源：变量 + 接口双保险 ===\n');
check('★ 有 currentRole() 统一取角色', /function currentRole\(\)/.test(client));
check('★ 优先用已有变量', /const known = \(typeof window !== 'undefined' && window\.__SP_ACCOUNT_ROLE\)/.test(client));
check('★ 变量为空时主动查 /mm/api/auth/me',
  /fetch\('\/mm\/api\/auth\/me'/.test(client) && /__spRoleProbe/.test(client));
check('★ 查到后缓存并补回全局变量', /__spRoleCache = role/.test(client) && /window\.__SP_ACCOUNT_ROLE = role/.test(client));
check('★ installAdminEntry 用 currentRole() 而不是直接读变量',
  /const role = currentRole\(\);/.test(client));
check('★ 接口失败时不影响其它功能（返回空而非抛错）',
  /catch \{ return ''; \}/.test(client));

console.log('\n=== 仍然有定时重试 ===\n');
check('每 1.5s 跑一次 installAdminEntry',
  /setInterval\(\(\) => \{ try \{ installAdminEntry\(\); \} catch/.test(client));

console.log('\n=== 页面上不一定存在旧变量（这是要覆盖的场景）===\n');
console.log('  场景 A：account-title.js 正常 → __SP_ACCOUNT_ROLE="owner" → 立刻显示');
console.log('  场景 B：该变量为空 → 第一次 currentRole() 返回空、并发查询接口 →');
console.log('          1.5s 后缓存命中 "owner" → 显示');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
