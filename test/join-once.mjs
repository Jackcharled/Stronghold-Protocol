// 手输同盟密钥「要输两次才能进」的回归测试。
//
// 现象：玩家输入密钥 → 页面刷新跳到他所在节点 → 还是要再输一次密钥。
//
// 两个成因（都在 matchmaker/public/client.js）：
//   A) 启动分支里 JOIN_COOKIE 排在 PENDING_JOIN 前面。跨节点跳转时目标房间记在
//      mm.pendingRoom，而 sp_join 里可能还留着上一次的邀请码，于是先去解析旧码，
//      甚至为它再跳一次节点。
//   B) joinFlow 的 tick 只判 `if (s.room)` 就 joined = true。刷新后 store 里还留着
//      刷新前/别的房间，room.join 根本没发出去。
//
//   node test/join-once.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = readFileSync(resolve(root, 'matchmaker/public/client.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log(`  OK  ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${extra ? `  ${extra}` : ''}`); }
};

console.log('手输同盟密钥：一次就能进入');

// --- A) 分支顺序 ---
// 整段启动分支：从 hostFlow 那个 elseif 到 roomUi(sp)
const iHost = src.indexOf('IS_HOST && MID && TICKET && SECRET && DIFF) hostFlow');
const iRoomUi = src.indexOf('roomUi(sp);', iHost);
ok('找到启动分支链', iHost >= 0 && iRoomUi > iHost);
if (iHost >= 0 && iRoomUi > iHost) {
  const block = src.slice(iHost, iRoomUi);
  const iPending = block.indexOf('PENDING_JOIN) joinFlow');
  const iCookie = block.indexOf('JOIN_COOKIE) resolveRoomNode');
  ok('★ PENDING_JOIN 分支存在', iPending >= 0);
  ok('★ JOIN_COOKIE 分支存在', iCookie >= 0);
  ok('★ PENDING_JOIN 排在 JOIN_COOKIE 之前', iPending >= 0 && iCookie >= 0 && iPending < iCookie,
    `PENDING_JOIN@${iPending} vs JOIN_COOKIE@${iCookie}`);
}

// --- B) joinFlow 按目标房间判断 ---
ok('★ joinFlow 比较房间号，而不是只看「有没有房间」',
  /const sameRoom = s\.room && String\(s\.room\.code\)\.toUpperCase\(\) === String\(code\)\.toUpperCase\(\);/.test(src));
ok('★ 只有同房间才直接跳过', /if \(sameRoom\) \{ joined = true; cleanUrl\(\); return; \}/.test(src));
ok('不再有裸的 `if (s.room) { joined = true; return; }`',
  !/if \(s\.room\) \{ joined = true; return; \}/.test(src));

// --- 行为模拟：复刻 sameRoom 判断 ---
const isSame = (roomCode, target) =>
  !!roomCode && String(roomCode).toUpperCase() === String(target).toUpperCase();

console.log('\n  === 场景模拟 ===');
ok('store 里是别的房间 → 应该真的发 join', isSame('OLDX', 'WZFP') === false);
ok('store 里是同一房间（大小写不同）→ 视作已加入', isSame('wzfp', 'WZFP') === true);
ok('store 里没有房间 → 应该真的发 join', isSame(null, 'WZFP') === false);
ok('刷新前的残留房间不等于目标 → 应该真的发 join', isSame('KAZB', 'RVJC') === false);

// --- 跨节点跳转后 pending room 会被消费掉（不能残留导致重复跳转）---
ok('读取 pendingRoom 时立刻清除', /sessionStorage\.removeItem\('mm\.pendingRoom'\)/.test(src));

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
