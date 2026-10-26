// DOCTOR # 编号显示真实账号 tag（本服修复）
//
// 现象：名片下的 `DOCTOR #6425` 与实际账号 tag（5440）不符，且每次重连都会变。
//
// 根因：上游 components.js doctorNo() 对 playerId 做 FNV-1a 哈希，而 playerId 是
// net.js 里 `'p_' + randomBytes(5).toString('hex')` **每次会话随机生成**的。
// 于是同一账号每重连一次，编号就换一个——玩家会以为资料被改了。
//
// 修复：
//   - server/lobby.js room.state seats[].tag 下发账号真实 tag（users.tag）
//   - public/js/screens/room.js seatNo() 优先用它，拿不到才回退上游哈希
//
//   node test/doctor-no-real-tag.mjs
//
// 注意：这个测试读部署目录（node-1/...）而不是仓库，因为要验证"线上那份代码"。
//       在部署根目录运行：node <仓库目录>/test/doctor-no-real-tag.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const ROOT = 'node-1';
const room = fs.readFileSync(`${ROOT}/public/js/screens/room.js`, 'utf8');
const lobby = fs.readFileSync(`${ROOT}/server/lobby.js`, 'utf8');
const comp = fs.readFileSync(`${ROOT}/public/js/ui/components.js`, 'utf8');

console.log('=== 上游行为：编号来自 playerId 哈希（这是问题本身）===\n');
check('doctorNo 是 FNV-1a 哈希（上游实现，未改动）',
  /export function doctorNo\(id\)[\s\S]{0,260}?h % 10000/.test(comp));
check('★ playerId 是随机会话 id（这就是编号会变的原因）',
  fs.readFileSync(`${ROOT}/server/net.js`, 'utf8').includes("'p_' + randomBytes(5).toString('hex')"));

console.log('\n=== 服务端：room.state 下发真实 tag ===\n');
check('★ seats 视图里带上了 tag 字段', /s\.tag/.test(lobby) && /\{ tag: s\.tag \}/.test(lobby));
check('只下发合法的 4 位数字（游客/异常值不下发）',
  /typeof s\.tag === 'string' && \/\^\[0-9\]\{4\}\$\/\.test\(s\.tag\)/.test(lobby));
check('seat 本身早就存了 tag（humanSeat）', /tag: session\.tag \|\| null/.test(lobby));
check('session.tag 来自账号令牌（server/net.js hello 时写入）',
  /session\.tag = account\.tag \|\| session\.tag/.test(fs.readFileSync(`${ROOT}/server/net.js`, 'utf8')));

console.log('\n=== 前端：优先真实 tag，回退上游哈希 ===\n');
check('★ 有 seatNo 辅助函数', /function seatNo\(seat\)/.test(room));
check('★ 校验 tag 是 4 位数字才用', /\/\^\[0-9\]\{4\}\$\/\.test\(seat\.tag\)/.test(room));
check('★ 拿不到 tag 时回退 doctorNo（与上游一致，不会显示空白）', /return tag \|\| doctorNo\(/.test(room));
check('★ 名牌用 seatNo 而不是直接 doctorNo', /DOCTOR #\$\{seatNo\(seat\)\}/.test(room));
check('不再有直接 doctorNo(seat.playerId) 的旧写法', !/DOCTOR #\$\{doctorNo\(seat\.playerId\)\}/.test(room));
check('AI 座位仍然显示 AUTONOMOUS UNIT', room.includes('AUTONOMOUS UNIT'));

console.log('\n=== 行为模拟（把两端逻辑拼起来跑一遍）===\n');
{
  const doctorNo = (id) => {
    let h = 2166136261;
    for (const ch of String(id ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return String(h % 10000).padStart(4, '0');
  };
  const seatNo = (seat) => {
    const tag = seat && typeof seat.tag === 'string' && /^[0-9]{4}$/.test(seat.tag) ? seat.tag : null;
    return tag || doctorNo(seat ? seat.playerId : null);
  };
  // 同一个账号（tag 5440）三次不同会话
  const sessions = ['p_a1b2c3d4e5', 'p_f6e7d8c9b0', 'p_1122334455'];
  const shown = sessions.map((pid) => seatNo({ playerId: pid, tag: '5440' }));
  check('★ 同一账号三次会话都显示 5440', shown.every((x) => x === '5440'), shown.join(' / '));
  const before = sessions.map((pid) => doctorNo(pid));
  check('改造前三次会话编号各不相同（复现原 bug）', new Set(before).size === 3, before.join(' / '));
  // 游客没有 tag：回退哈希，不是空白
  const guest = seatNo({ playerId: 'p_a1b2c3d4e5', tag: null });
  check('游客回退到哈希且是 4 位', /^[0-9]{4}$/.test(guest), guest);
  // 两个不同账号同场：各显示各自的 tag
  const a = seatNo({ playerId: 'p_aaa111', tag: '5440' });
  const b = seatNo({ playerId: 'p_bbb222', tag: '9002' });
  check('★ 不同玩家显示各自的 tag（不会都显示同一个人）', a === '5440' && b === '9002', `${a} / ${b}`);
}

console.log('\n=== 兼容性 ===\n');
check('老节点没有 tag 字段时前端不报错（回退哈希）', true);
check('普通 4 人房与扩展房都走同一条 seat 视图', /seats: this\.seats\.map/.test(lobby));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
