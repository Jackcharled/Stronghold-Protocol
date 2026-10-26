// 验证悬赏选卡的 AI 行为：
//   **5–20 人房里 AI 默认就能重复选（多人悬赏同一目标），与 allowRepeat 无关。**
//   allowRepeat 只控制「盟约策略」能否重复。
//   node test\bot-sp-repeat.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

// 复刻 spCardAvailable 的判断（真实逻辑）
function spCardAvailable(o, card, player = null) {
  if (!card) return false;
  if (!o.capacityExperiment && o.sp?.taken[card.idx] != null) return false;
  return card.kind !== 'item' || (player ? o.itemPoolFor(player).canGain(card.id) : o.itemPool.canGain(card.id));
}

console.log('=== 1) 5–20 人房：AI 可重复选（与 allowRepeat 无关）===\n');
for (const allowRepeat of [false, true]) {
  const o = {
    capacityExperiment: true,
    allowRepeat,                       // 悬赏不看它
    sp: { taken: { 0: 'p1' } },        // p1 已选走 idx 0
    itemPoolFor: () => ({ canGain: () => true }),
    itemPool: { canGain: () => true },
  };
  const ok = spCardAvailable(o, { idx: 0, kind: 'bounty' }, { playerId: 'bot' });
  check(`★ allowRepeat=${allowRepeat} 时 AI 仍能选已被选走的悬赏`, ok === true, `实际 ${ok}`);
}

console.log('\n=== 2) 4 人房：仍按 taken 判重 ===\n');
{
  const o = {
    capacityExperiment: false,
    allowRepeat: false,
    sp: { taken: { 0: 'p1' } },
    itemPoolFor: () => ({ canGain: () => true }),
    itemPool: { canGain: () => true },
  };
  const ok = spCardAvailable(o, { idx: 0, kind: 'bounty' }, { playerId: 'bot' });
  check('★ 4 人房 AI 不能选已被选走的悬赏', ok === false, `实际 ${ok}`);
  const ok2 = spCardAvailable(o, { idx: 1, kind: 'bounty' }, { playerId: 'bot' });
  check('4 人房 AI 能选未被选走的悬赏', ok2 === true, `实际 ${ok2}`);
}

console.log('\n=== 3) 源码契约 ===\n');
const spJs = fs.readFileSync('node-1/server/match/match/spDraft.js', 'utf8');
const botJs = fs.readFileSync('node-1/server/match/bot.js', 'utf8');

check('★ 悬赏判重只看 capacityExperiment，不看 allowRepeat',
  /if \(!this\.capacityExperiment && this\.sp\?\.taken\[card\.idx\] != null\) return false;/.test(spJs)
  && !/allowRepeat[\s\S]{0,80}sp\?\.taken/.test(spJs));
check('★ AI 取可用集合时传了 ps（物品按人取池）',
  /const avail = s\.cards\.filter\(\(c\) => this\.spCardAvailable\(c, ps\)\)/.test(spJs));
check('AI 的 botPickCard 只在 available 里挑', /for \(const i of available\)/.test(botJs));
check('★ 盟约的 allowRepeat 与悬赏无关（bot.js 里的 reserve 只作用于盟约）',
  /const reserve = m\.allowRepeat === true \? 1 : SOFT_BAND_RESERVE;/.test(botJs));

// 顺序草稿路径也不该漏传 ps（第 89 行的「整体还有没有卡」是队伍视角，单独看）
const noPs = [...spJs.matchAll(/spCardAvailable\(c\)/g)];
check('★ 顺序草稿路径也传 ps（不依赖全队共享池）', noPs.length <= 1,
  noPs.length > 1 ? `还有 ${noPs.length} 处没传 ps` : `仅 ${noPs.length} 处（队伍视角的总量检查，正确）`);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
