// 「恢复对局」按钮必须在该出现的时候出现。
// 玩家反馈：登录了、也确实有一局在跑，界面上却没有这个按钮。
//   node test/resume-button-visible.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const client = fs.readFileSync('matchmaker/public/client.js', 'utf8');
const api = fs.readFileSync('matchmaker/account.cjs', 'utf8');

// 抽出 inRoom 的实现，用各种状态跑一遍（这是按钮「消失」的头号原因）
const start = client.indexOf('const inRoom = () => {');
const end = client.indexOf('};', client.indexOf('return online && inMatch;')) + 2;
const inRoomSrc = client.slice(start, end);
check('能找到 inRoom 实现', inRoomSrc.includes('return online && inMatch'));

function makeInRoom(sp) {
  // eslint-disable-next-line no-new-func
  return new Function('window', inRoomSrc + '\nreturn inRoom;')({ __SP__: sp });
}

console.log('=== inRoom()：什么时候该「不需要按钮」===\n');
const cases = [
  ['掉线但 store 里还有 room（关键场景）', { net: { status: 'offline' }, store: { get: () => ({ room: { code: 'ABCD' }, match: { phase: 'PREP' } }) } }, false],
  ['在线 + 在对局中', { net: { status: 'online' }, store: { get: () => ({ room: { code: 'ABCD' }, match: { phase: 'PREP' } }) } }, true],
  ['在线 + 只在房间里没开局', { net: { status: 'online' }, store: { get: () => ({ room: { code: 'ABCD' } }) } }, false],
  ['在线 + 什么都没有（大厅）', { net: { status: 'online' }, store: { get: () => ({ room: null }) } }, false],
  ['store 还没就绪', { net: { status: 'online' }, store: null }, false],
];
for (const [label, sp, want] of cases) {
  const got = makeInRoom(sp)();
  check(`${label} → ${want ? '在房间里' : '不在（应显示按钮）'}`, got === want, `got=${got}`);
}

console.log('\n=== 根因核对：旧实现只看 room.code ===\n');
check('★ 旧实现确实是 `room && room.code`（掉线时误判为在房间）',
  client.includes('return !!(room && room.code)') === false, '已不再使用该判据');
check('★ 新判据要求 socket 在线', /const online = !!\(sp\.net && sp\.net\.status === 'online'\)/.test(client));
check('★ 新判据要求确实在对局中', /const inMatch = !!\(s\.match && \(s\.match\.phase \|\| s\.match\.public\)\)/.test(client));

console.log('\n=== 自动恢复标记不会永久挡住按钮 ===\n');
check('★ __SP_ACCOUNT_RESUME_PENDING 有 12s 时间保护',
  /Date\.now\(\) - pendingSince > 12000/.test(client));

console.log('\n=== 锚点找不到时仍有入口 ===\n');
check('★ 所有锚点都缺失时退回固定定位按钮',
  /mm-resume-fallback/.test(client) && /position:fixed/.test(client));
check('兜底按钮点击后同样跳转',
  (() => {
    const i = client.indexOf('mm-resume-fallback');
    const seg = client.slice(i, i + 1200);
    return seg.includes("location.assign('/r/'") && seg.includes('accountResume=1');
  })());

console.log('\n=== 数据来源必须是「进行中的对局」===\n');
check('只看 started === true 的房间', /if \(room\.started !== true\) continue;/.test(api));
check('按账号 ID 精确匹配', /String\(p\.accountId\) === uid/.test(api));
check('接口要求登录', /if \(!u\) return sendJson\(res, 401/.test(api));

console.log('\n=== 按钮的显示轮询 ===\n');
check('1.5s / 4s / 8s 各试一次，之后每 6s',
  /setTimeout\(probe, 1500\)/.test(client) && /setTimeout\(probe, 4000\)/.test(client)
  && /setTimeout\(probe, 8000\)/.test(client) && /setInterval\(probe, 6000\)/.test(client));
check('账号变化时立即重查', /sp:account-changed/.test(client));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
