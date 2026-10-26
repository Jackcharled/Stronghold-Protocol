// 复现 4 人局（2 真人 + 2 AI）选策略阶段，逐个用真实 gameLogic 计算 canSkip 的每一项。
//   node test/band-skip-4p.mjs
import { normalizeDraft, draftMyTurn, sortedPlayers } from '../node-1/public/js/ui/gameLogic.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

// 截图里的局面：P1/P2 已选（✓），P3 是我（决策中），P4 等待中；4 人房、顺序选
const players = [
  { playerId: 'ai1', name: 'AI·阿米娅', isBot: true },
  { playerId: 'ai2', name: 'AI·华法琳', isBot: true },
  { playerId: 'me', name: '测试博士', isBot: false },
  { playerId: 'p4', name: '武桐_Uton', isBot: false },
];
const ME = 'me';
const skipsPerPlayer = 1; // data/config.json → bandDraft.skipsPerPlayer

function caseOf(label, draft, solo = false) {
  const players2 = sortedPlayers({ players });
  const d = normalizeDraft(draft, players2);
  const myPick = d.picks.get(ME) || null;
  const myTurn = !myPick && draftMyTurn(d, ME, solo);
  const skipsLeft = d.skipsLeft.has(ME) ? d.skipsLeft.get(ME) : 1;
  const othersLeft = d.order.filter((pid) => !d.picks.has(pid)).length;
  const canSkip = !solo && !d.concurrent && myTurn && skipsLeft > 0 && othersLeft > 1;
  // 服务端同口径（phases.js 的 skips）
  const srvConcurrent = !!draft.concurrent;
  const srvSkips = solo || srvConcurrent ? 0 : skipsPerPlayer;
  console.log(`\n--- ${label} ---`);
  console.log(`  order=${JSON.stringify(d.order)}  turn=${JSON.stringify(d.turnPid)}  concurrent=${srvConcurrent}`);
  console.log(`  myPick=${myPick}  myTurn=${myTurn}  skipsLeft=${skipsLeft}  othersNotPicked=${othersLeft}`);
  console.log(`  服务端 skipsLeft(每人)=${srvSkips}`);
  console.log(`  => canSkip = ${canSkip}`);
  return { d, myPick, myTurn, skipsLeft, othersLeft, canSkip, srvSkips };
}

console.log('=== 4 人局（2 真人 + 2 AI）顺序选策略 ===\n');

// 核心场景：轮到我、队友还有没选的（AI 已选完，p4 还没选）
const a = caseOf('轮到我（华法琳/阿米娅已选，p4 未选）', {
  order: ['ai1', 'ai2', ME, 'p4'],
  turn: ME,
  picks: { ai1: 'band_bldsk', ai2: 'band_xxx' },
  skipsLeft: { ai1: 1, ai2: 1, [ME]: 1, p4: 1 },
});
check('★ 轮到我 + 还有队友未选 → 可以跳过', a.canSkip === true);

// 我是最后一个：没有下一个人可让位
const b = caseOf('我是最后一个未选的（p4 已选）', {
  order: ['ai1', 'ai2', 'p4', ME],
  turn: ME,
  picks: { ai1: 'b1', ai2: 'b2', p4: 'b3' },
  skipsLeft: { ai1: 1, ai2: 1, [ME]: 1, p4: 1 },
});
check('最后一个人不能跳过（无人可让位）', b.canSkip === false);

// 跳过用完之后
const c = caseOf('跳过次数已用完', {
  order: ['ai1', 'ai2', ME, 'p4'],
  turn: ME,
  picks: { ai1: 'b1', ai2: 'b2' },
  skipsLeft: { ai1: 1, ai2: 1, [ME]: 0, p4: 1 },
});
check('skipsLeft=0 → 不能跳过', c.canSkip === false);

// 还没轮到我
const d0 = caseOf('还没轮到我（p4 正在决策）', {
  order: ['ai1', 'ai2', 'p4', ME],
  turn: 'p4',
  picks: { ai1: 'b1', ai2: 'b2' },
  skipsLeft: { ai1: 1, ai2: 1, [ME]: 1, p4: 1 },
});
check('不是我的回合 → 不能跳过（但会显示「正在选择策略」而非按钮）', d0.canSkip === false);

console.log('\n=== 分支判定：此刻该显示什么 ===\n');
const headOf = (x) => {
  const allPicked = x.d.done || (x.d.order.length > 0 && x.d.order.every((pid) => x.d.picks.has(pid)));
  if (allPicked) return '策略选择完成';
  if (x.myTurn) return '请选择策略 + 跳过按钮';
  const nm = players.find((p) => p.playerId === x.d.turnPid)?.name;
  return nm ? `${nm} 正在选择策略…` : 'null（什么都不显示）';
};
console.log(`  轮到我（场景1）      → ${headOf(a)}`);
console.log(`  我是最后一人（场景2）→ ${headOf(b)}`);
check('★ 轮到我时必须进入「请选择策略」分支（按钮才可能渲染）', headOf(a).includes('跳过按钮'));

// 并发草稿（5–20 人大厅）：不应有跳过
const e = caseOf('5–20 人大厅并发草稿', {
  order: ['ai1', 'ai2', ME, 'p4'],
  turn: null,
  concurrent: true,
  picks: { ai1: 'b1', ai2: 'b2' },
  skipsLeft: { ai1: 0, ai2: 0, [ME]: 0, p4: 0 },
});
check('并发草稿不得出现跳过', e.canSkip === false);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
