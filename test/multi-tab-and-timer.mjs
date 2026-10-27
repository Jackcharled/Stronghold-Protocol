// 多标签页同账号 / 倒计时浮层 / 卡在「正在进入模拟」
//
//   node test/multi-tab-and-timer.mjs
//
// 三个玩家实测到的现象：
//   1. 同设备开 2 个标签页登同一账号 → 来回切换、互相抢座位
//   2. 进了对局，头顶还挂着「管理员房 · 不自动销毁」倒计时浮层
//      （那个浮层本应只在同盟等待室出现）
//   3. 页面永远停在「正在进入模拟…」，看不出任何进展
//
// 现象 3 的根因：服务端用 4001 关掉被接管的那个 socket（net.js _onClose），
// 前端只弹一条 toast，**界面什么都不动** —— 被接管的那一页就永远停在原画面。
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const main = fs.readFileSync('public/js/main.js', 'utf8');
const net = fs.readFileSync('public/js/net.js', 'utf8');
const cli = fs.readFileSync('matchmaker/public/client.js', 'utf8');
const lobby = fs.readFileSync('server/lobby.js', 'utf8');

console.log('=== 1) 服务端：同账号接管 ===\n');
check('有 account.detached 通知旧会话', /account\.detached/.test(lobby));
check('用 4001 关闭旧 socket', /close\(4001/.test(lobby));
check('同房间同账号走 takeover 而不是直接拒绝', /takeover|让座|接管/.test(lobby) || /conflict\.room === room/.test(lobby));

console.log('\n=== 2) 前端：被接管后不再自动重连（避免两页互抢）===\n');
check('net.js 识别 4001 = CLOSE_REPLACED', /export const CLOSE_REPLACED = 4001/.test(net));
check('被接管时置 _manualClose（不自动重连）', /ev\.code === CLOSE_REPLACED[\s\S]{0,200}_manualClose = true/.test(net));
check('发出 replaced 事件', /_emit\('replaced'/.test(net));

console.log('\n=== 3) ★ 被接管的那一页必须清理界面（这是本次的核心修复）===\n');
const replacedHandler = /net\.on\('replaced',([\s\S]{0,900}?)\n  \}\);/.exec(main);
check('有 replaced 处理', !!replacedHandler);
if (replacedHandler) {
  const body = replacedHandler[1];
  check('★ 清掉 room', /store\.set\(\{ room: null/.test(body));
  check('★ 清掉 match', /match: null/.test(body));
  check('★ 清掉 ui.pendingJoin（否则本页还会去抢着加入）', /pendingJoin: null/.test(body));
  check('★ 收掉残留的过渡遮罩 mm-overlay', /'mm-overlay'/.test(body));
  check('★ 收掉倒计时浮层 mm-room-timer', /mm-room-timer/.test(body));
  check('提示文案说明「要在这个页面继续玩请刷新」',
    /本页已断开/.test(body) && /刷新/.test(body));
}

console.log('\n=== 4) 倒计时浮层只在同盟等待室显示 ===\n');
const tickIdx = cli.indexOf('const roomOk = entered');
check('★ 要求 session.entered（标题页不显示）', tickIdx > 0 && cli.slice(tickIdx - 400, tickIdx + 500).includes('entered'));
check('★ 进了对局（match.public 存在）不显示',
  /!\(s\.match && s\.match\.public\)/.test(cli));
check('★ 有结算结果不显示', /!\(s\.match && s\.match\.result\)/.test(cli));
check('★ 房间码必须是四字符（残留数据不显示）',
  /room\.code\.length === 4/.test(cli));
check('★ 对局界面已渲染时也不显示（双保险）',
  /document\.querySelector\('\.game-screen'\)/.test(cli));
check('不满足时真的把元素移除（不是只 return）',
  /if \(!roomOk\) \{\s*\n\s*const dead = document\.getElementById\('mm-room-timer'\);\s*\n\s*if \(dead\) dead\.remove\(\);/.test(cli));

console.log('\n=== 5) 行为模拟：各状态下浮层是否该显示 ===\n');
{
  const shouldShow = (s) => {
    const entered = !!(s.session && s.session.entered);
    const room = s.room;
    return entered && !!room && typeof room.code === 'string' && room.code.length === 4
      && !(s.match && s.match.public) && !(s.match && s.match.result);
  };
  const cases = [
    ['标题页（未进入大厅）', { session: { entered: false }, room: { code: 'ABCD' } }, false],
    ['同盟等待室', { session: { entered: true }, room: { code: 'ABCD' } }, true],
    ['进了对局（有 match.public）', { session: { entered: true }, room: { code: 'ABCD' }, match: { public: { phase: 'PREP' } } }, false],
    ['已结算', { session: { entered: true }, room: { code: 'ABCD' }, match: { result: {} } }, false],
    ['残留房间数据（码无效）', { session: { entered: true }, room: { code: 'AB' } }, false],
    ['没有房间', { session: { entered: true }, room: null }, false],
    ['选策略阶段（match.public 在）', { session: { entered: true }, room: { code: 'ABCD' }, match: { public: { phase: 'BAND_DRAFT' } } }, false],
  ];
  let ok = true;
  for (const [name, s, want] of cases) {
    const got = shouldShow(s);
    const mark = got === want ? '✓' : '✗';
    if (got !== want) ok = false;
    console.log(`     ${mark} ${name.padEnd(28)} 显示=${got}`);
  }
  check('★ 七种状态全部符合预期', ok);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
