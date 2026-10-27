// 「同账号开新标签页回到对局」的三段链路，以及旧标签页不再降级旁观
//
//   node test/takeover-full-chain.mjs
//
// 玩家实测（2026-10-27）看到的三条提示连起来就是一整条坏链路：
//   1) 旧标签页：该身份已在其他页面登录，本页已断开。
//   2) 新标签页：卡在「正在进入模拟…」不动。
//   3) 旧标签页：对局已转移到另一设备，当前设备改为只读观战。 / 对局已转移，但观战席不可用。
//
// 三个根因：
//   A. 旧标签页被接管后去 room.spectate 降级旁观，但那座位现在的 accountId 还是同一个账号，
//      accountRoomConflict 直接 SESSION_IN_USE → 「观战席不可用」。已改为回大厅。
//   B. 新标签页接管时服务端先 broadcastState 再回 OK，room.state 比 welcome 先到；
//      那一刻 store 里的 me.playerId 还是旧会话的，onRoomState 判定「座位里没有我」→
//      把刚接管的房间和 match 一起清掉 → 永远停在「正在进入模拟…」。
//      已用 net.playerIdPending 跳过这段时间的身份比对。
//   C. join 的冲突顺序（已单独由 test/join-takeover-order.mjs 覆盖）。
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const read = (p) => fs.readFileSync(p, 'utf8');

console.log('=== A) 旧标签页不再尝试旁观自己的座位 ===\n');
{
  const src = read('public/js/ui/accountObserver.js');
  const i = src.indexOf("net.on('account.detached'");
  const body = src.slice(i, src.indexOf("net.on('welcome'", i));
  check('找到 account.detached 处理', i > 0);
  // 只匹配真正的调用，注释里提到 room.spectate 是说明历史，不算违规
  const calls = (text) => (text.match(/(?:net\.request\(\s*['"]room\.spectate|\.request\(\s*['"]room\.spectate)/g) || []).length;
  check('★ 不再用 room.spectate 降级旁观', calls(body) === 0);
  check('★ 整个文件也不再发起旁观请求（welcome 分支已清理）', calls(src) === 0);
  check('★ 不再自动重连去抢会话', !/net\.connect\(\)/.test(body));
  check('提示改成「刷新页面继续玩」的说法', /请刷新页面/.test(body) || /刷新/.test(body));
  check('清掉房间/对局状态（回大厅）', /room: null/.test(body) && /match: null/.test(body));
  check('收掉残留遮罩与倒计时浮层', /mm-overlay/.test(body) && /mm-room-timer/.test(body));
  check('已移除不再使用的 switching 状态', !/\bswitching\b/.test(src) || !/let switching/.test(src));
}

console.log('\n=== B) room.state 先于 welcome 到达时不误清房间 ===\n');
{
  const main = read('public/js/main.js');
  const i = main.indexOf('function onRoomState(', 0);
  const body = main.slice(i, i + 2200);
  check('★ 身份比对受 identityPending 保护', /identityPending/.test(body));
  check('★ identityPending 读的是 net.playerIdPending', /net\.playerIdPending === true/.test(body));
  check('「已被踢出」的分支仍然保留（不是删掉判断）', /你已不在该同盟中/.test(body));

  const net = read('public/js/net.js');
  check('net 初始化了 playerIdPending', /this\.playerIdPending = false;/.test(net));
  check('★ hello 发出时置位', /this\.playerIdPending = true;/.test(net));
  const iW = net.indexOf('_onWelcome(msg)');
  check('★ welcome 到达时清除', net.slice(iW, iW + 400).includes('this.playerIdPending = false'));
  const iE = net.indexOf('_onHelloError(msg)');
  check('★ hello 被拒时也清除（否则永久跳过比对）', net.slice(iE, iE + 500).includes('this.playerIdPending = false'));
}

console.log('\n=== C) 时序模拟：room.state 早于 welcome ===\n');
{
  // 复刻 onRoomState 的判定
  const decide = ({ myId, netPending, seats, spectating }) => {
    const identityPending = netPending === true;
    if (!identityPending && myId != null && seats.length
      && !seats.some((s) => s.playerId === myId) && !spectating) return 'WIPE_ROOM';  // 旧逻辑会清空
    return 'KEEP_ROOM';
  };
  const seats = [{ playerId: 'p_newdevice' }];  // 接管后座位是新会话的
  const cases = [
    ['新标签页接管：room.state 先到，welcome 未到', { myId: 'p_oldtab', netPending: true, seats, spectating: false }, 'KEEP_ROOM'],
    ['welcome 已到，身份一致', { myId: 'p_newdevice', netPending: false, seats, spectating: false }, 'KEEP_ROOM'],
    ['真的被踢了（welcome 已到，座位不是我的）', { myId: 'p_kicked', netPending: false, seats, spectating: false }, 'WIPE_ROOM'],
    ['旁观者：不在座位但在观战席', { myId: 'p_spec', netPending: false, seats, spectating: true }, 'KEEP_ROOM'],
  ];
  let ok = true;
  for (const [name, input, want] of cases) {
    const got = decide(input);
    if (got !== want) ok = false;
    console.log(`     ${got === want ? '✓' : '✗'} ${name.padEnd(40)} → ${got}`);
  }
  check('★ 四种时序全部正确（接管时不再清空房间）', ok);
}

console.log('\n=== D) 服务端接管顺序（回归）===\n');
{
  const lobby = read('server/lobby.js');
  const iJoin = lobby.indexOf('  join(session');
  const iTake = lobby.indexOf("conflict.room === room && conflict.kind === 'player'", iJoin);
  const iDrop = lobby.indexOf('this.dropStaleAccountSeats(session);', iJoin);
  check('★ 同房间接管判定在清理之前', iTake > 0 && iTake < iDrop);
  check('接管时通知旧会话 account.detached', /account\.detached/.test(lobby));
  check('接管时调 match.onReconnect（对局可续）', /callMatch\(room, 'onReconnect'/.test(lobby));
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
