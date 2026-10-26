// 「跳过」按钮的开关条件：只由「允许重复选择策略」(allowRepeat) 决定，与人数无关。
//
//   4 人房                        → 顺序草稿，「队友已选」判重，有跳过
//   5–20 人房 + allowRepeat 关     → 顺序草稿，「队友已选」判重，有跳过   ← 本提交改动的部分
//   5–20 人房 + allowRepeat 开     → 并发草稿，不判重，没有跳过
//
//   node test/skip-boundary.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

// 复刻 Match.js 的判定（与源码逐字对应，换成纯函数）
function flags({ isSolo = false, playerCapacity = 4, allowRepeat = false } = {}) {
  const capacityExperiment = !isSolo && playerCapacity > 4;
  const allowRepeatEffective = capacityExperiment && allowRepeat === true;
  // Match.concurrentDraft()
  const concurrentDraft = !!capacityExperiment && !isSolo && allowRepeatEffective;
  return { capacityExperiment, allowRepeatEffective, concurrentDraft };
}
// 复刻 phases.js enterBandDraft / bandTaken / skipBand
function draftInfo(f) {
  const skipsPerPlayer = 1;
  const skips = f.concurrentDraft ? 0 : skipsPerPlayer;
  return {
    skips,
    hasSkipAction: !f.concurrentDraft,
    buttonCanAppear: !f.concurrentDraft && skips > 0,
    dedupes: !f.allowRepeatEffective,   // bandTaken: if (this.allowRepeat) return false
  };
}

console.log('=== 源码核对：concurrentDraft 绑定 allowRepeat ===\n');
const matchJs = fs.readFileSync('node-1/server/match/Match.js', 'utf8');
check('★ concurrentDraft() 要求 allowRepeat',
  /concurrentDraft\(\) \{\s*\n\s*return !!this\.capacityExperiment && !this\.isSolo && this\.allowRepeat;/.test(matchJs));
check('allowRepeat 只在 5–20 人房生效',
  /this\.allowRepeat = this\.capacityExperiment && this\.experimental\.allowRepeat === true;/.test(matchJs));
check('capacityExperiment = playerCapacity > 4',
  /this\.capacityExperiment = !this\.isSolo && this\.playerCapacity > 4;/.test(matchJs));

const phases = fs.readFileSync('node-1/server/match/match/phases.js', 'utf8');
check('bandTaken 用 allowRepeat 判重（关掉时正常拦「队友已选」）',
  /bandTaken\(bandId, playerId\) \{\s*\n\s*if \(this\.allowRepeat\) return false;/.test(phases));
check('skipBand 在并发草稿里拒绝',
  /if \(d\.concurrent\) return fail\(ERR\.WRONG_PHASE, 'no skip in a concurrent draft'\)/.test(phases));
check('并发草稿 skipsLeft = 0', /const skips = this\.isSolo \|\| concurrent \? 0/.test(phases));

console.log('\n=== 组合矩阵 ===\n');
const rows = [
  { label: '4 人房，允许重复 关', playerCapacity: 4, allowRepeat: false },
  { label: '4 人房，允许重复 开', playerCapacity: 4, allowRepeat: true },
  { label: '5 人房，允许重复 关', playerCapacity: 5, allowRepeat: false },
  { label: '5 人房，允许重复 开', playerCapacity: 5, allowRepeat: true },
  { label: '10 人房，允许重复 关', playerCapacity: 10, allowRepeat: false },
  { label: '10 人房，允许重复 开', playerCapacity: 10, allowRepeat: true },
  { label: '20 人房，允许重复 关', playerCapacity: 20, allowRepeat: false },
  { label: '20 人房，允许重复 开', playerCapacity: 20, allowRepeat: true },
];
console.log('  ' + '场景'.padEnd(22) + '并发草稿  跳过  判重');
const got = {};
for (const r of rows) {
  const f = flags(r);
  const s = draftInfo(f);
  got[r.label] = s;
  console.log('  ' + r.label.padEnd(22) +
    (f.concurrentDraft ? '是      ' : '否      ') +
    (s.buttonCanAppear ? '有    ' : '没有  ') +
    (s.dedupes ? '是' : '否'));
}

console.log('\n=== 断言 ===\n');
check('4 人房（开关无关）：有跳过、判重',
  got['4 人房，允许重复 关'].buttonCanAppear && got['4 人房，允许重复 开'].buttonCanAppear
  && got['4 人房，允许重复 关'].dedupes && got['4 人房，允许重复 开'].dedupes);
check('★ 5 人房 + 允许重复 关 → 有跳过',
  got['5 人房，允许重复 关'].buttonCanAppear === true);
check('★ 5 人房 + 允许重复 开 → 没有跳过',
  got['5 人房，允许重复 开'].buttonCanAppear === false);
check('★ 20 人房 + 允许重复 关 → 有跳过',
  got['20 人房，允许重复 关'].buttonCanAppear === true);
check('★ 20 人房 + 允许重复 开 → 没有跳过',
  got['20 人房，允许重复 开'].buttonCanAppear === false);
check('没开 allowRepeat 的大房间仍然判重（顺序选里不能撞车）',
  got['5 人房，允许重复 关'].dedupes === true && got['20 人房，允许重复 关'].dedupes === true);
check('开了 allowRepeat 的大房间不判重（可重复选择）',
  got['5 人房，允许重复 开'].dedupes === false);

console.log('\n=== 前端与服务端同口径 ===\n');
const band = fs.readFileSync('node-1/public/js/screens/bandDraft.js', 'utf8');
check('前端 canSkip 在并发草稿时关掉跳过', /!draft\.concurrent && myTurn && skipsLeft > 0/.test(band));
check('前端 taken 只在「并发 + allowRepeat」时清空',
  /const taken = solo \|\| \(draft\.concurrent && draft\.allowRepeat\) \? new Map\(\)/.test(band));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
