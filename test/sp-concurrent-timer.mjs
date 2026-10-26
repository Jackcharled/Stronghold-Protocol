// 5–20 人「悬赏决策」的并发倒计时必须全程存在。
//
// 玩家反馈：计时器没了，掉线的人卡在这个界面出不去。
//
// 根因：spDraft._concurrentSpStep 里
//   if (!s.armed) { s.armed = true; this.setDeadline(...); s.turnDeadline = this.deadline; }
//   else { this.setDeadline(0); }        ← 这行
// _applyCard() 每选一张卡都会 startSpTurn() → _concurrentSpStep()，此时 armed 已为真，
// 于是走到 else，把整个阶段的倒计时清零。只要**有任何一人选了卡**，计时器就消失，
// 剩下的人只能干等（掉线的更是永远卡住）。
//
// 对照 _concurrentBandStep（盟约草稿）：那边没有 else 分支，倒计时设置后一直保持。
//
//   node test/sp-concurrent-timer.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const sp = fs.readFileSync('node-1/server/match/match/spDraft.js', 'utf8');
const phases = fs.readFileSync('node-1/server/match/match/phases.js', 'utf8');

// 抽出 _concurrentSpStep 函数体
function body(src, name) {
  const i = src.indexOf(`${name}() {`);
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}
const spStep = body(sp, '_concurrentSpStep');
const bandStep = body(phases, '_concurrentBandStep');
// 去掉注释再判断，否则注释里写的反例会被当成真代码
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const spCode = strip(spStep);
const bandCode = strip(bandStep);

console.log('=== 悬赏并发：不得在 armed 之后清零倒计时 ===\n');
check('找到 _concurrentSpStep', spCode.length > 100);
check('★ 没有 else { this.setDeadline(0) }',
  !/else\s*\{[\s\S]{0,120}?this\.setDeadline\(0\)/.test(spCode),
  '这一行导致「有人选卡 → 计时器消失」');
check('★ armed 之后不再出现 setDeadline(0)',
  (() => {
    const armedIdx = spCode.indexOf('if (!s.armed)');
    if (armedIdx < 0) return false;
    return !spCode.slice(armedIdx).includes('this.setDeadline(0)');
  })(),
  '阶段结束分支里的 setDeadline(0) 在 armed 判断之前，属于正常');
check('armed 期间保持 s.turnDeadline', /s\.turnDeadline = this\.deadline;/.test(spCode));

console.log('\n=== 对照：盟约并发的结构（为什么它没出问题）===\n');
check('_concurrentBandStep 的 else 只挂在 untimed 上（不是挂在 armed 上）',
  (() => {
    // 正确结构：if (!d.armed) { ... if (!d.untimed) { ... } else { setDeadline(0) } }
    // 错误结构：if (!d.armed) { ... } else { setDeadline(0) }
    const armedIdx = bandCode.indexOf('if (!d.armed)');
    if (armedIdx < 0) return false;
    const seg = bandCode.slice(armedIdx);
    const untimedIdx = seg.indexOf('if (!d.untimed)');
    // else 必须出现在 untimed 判断之后
    const elseIdx = seg.search(/else\s*\{/);
    return untimedIdx > 0 && elseIdx > untimedIdx;
  })(),
  '盟约的 else 属于「无计时模式」，不是「重复进入」分支');
check('两边的 armed 都只设置一次',
  bandCode.includes('if (!d.armed)') && spCode.includes('if (!s.armed)'));
check('★ 悬赏不再有挂在 armed 上的 else',
  !/if \(!s\.armed\)[\s\S]*?\}\s*else\s*\{/.test(spCode));

console.log('\n=== 超时兜底：掉线/不选的人必须被自动分配 ===\n');
check('★ 超时回调里给所有还没选的人派卡',
  /for \(const ps of deciding\) \{[\s\S]{0,200}?this\._applyCard\(ps, avail\[Math\.floor\(this\.rngDraft\(\) \* avail\.length\)\]\)/.test(spCode));
check('超时后重新评估阶段（有人补选完就结束）', /this\._applyCard\(ps,[\s\S]{0,200}?this\._concurrentSpStep\(\)/.test(spCode));

console.log('\n=== 选卡会重新进入该函数（这就是触发点）===\n');
check('★ _applyCard 末尾调用 startSpTurn',
  /_applyCard\(ps, idx\) \{[\s\S]{0,700}?this\.startSpTurn\(\);/.test(sp));
check('★ 并发时 startSpTurn 转进 _concurrentSpStep',
  /startSpTurn\(\) \{[\s\S]{0,120}?if \(s\.concurrent\) \{ this\._concurrentSpStep\(\); return; \}/.test(sp));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
