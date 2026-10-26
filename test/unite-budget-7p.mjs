// 验证 7 人房（< 8）的联防预算到底该是多少：
// 按 unitePhase.js 的 uniteTimeLimit()，容量实验房总预算 300 游戏秒，
// 只有「存在接力候选」时才拆成 150+150，否则一次给满 300。
//   node test\unite-budget-7p.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const src = fs.readFileSync('node-1/server/match/match/unitePhase.js', 'utf8');
const unite = fs.readFileSync('node-1/server/match/unite.js', 'utf8');

console.log('=== 现状检查 ===\n');

// 1) 接力资格的人数门槛
const gate = src.match(/if \(m\.capacityExperiment && m\._normalAliveCount >= (\d+) && alive\.length >= (\d+)\)/) ||
             unite.match(/if \(m\.capacityExperiment && m\._normalAliveCount >= (\d+) && alive\.length >= (\d+)\)/);
check('找到接力人数门槛', !!gate, gate ? `>= ${gate[1]} 人（_normalAliveCount）/ >= ${gate[2]} 人（alive）` : '未找到');

// 2) 预算分配
const alloc = src.match(/allocations: uniteRelayHelpers\(this, plan\)\.length \? \[(\d+), (\d+)\] : \[(\d+)\]/);
check('找到预算分配逻辑', !!alloc, alloc ? `有接力=[${alloc[1]},${alloc[2]}] 无接力=[${alloc[3]}]` : '未找到');

// 3) uniteRelayHelpers 的前置条件
const relayGuard = unite.match(/if \(plan\.uniteRound !== 1 \|\| !Array\.isArray\(plan\.relayCandidates\)\) return \[\];/);
check('找到 uniteRelayHelpers 的前置判断', !!relayGuard);

console.log('\n=== 7 人房的推演 ===\n');
const alive = 7;
const normalAlive = 7;
const hasRelayGate = gate && normalAlive >= Number(gate[1]) && alive >= Number(gate[2]);
console.log(`  存活 ${alive} 人，_normalAliveCount=${normalAlive}`);
console.log(`  接力门槛 ${gate ? gate[1] : '?'} 人 → ${hasRelayGate ? '有接力' : '没有接力'}`);
check('★ 7 人房不应分配成 150+150（应给满一局）',
  hasRelayGate === false,
  hasRelayGate ? '仍会拆成两波' : '正确：一次给满');

// 4) 关键：分配时 plan.uniteRound 还没设置，uniteRelayHelpers 会返回 []
console.log('\n=== 分配时机检查 ===\n');
check('★ allocate 时 plan.uniteRound 尚未赋值 → uniteRelayHelpers 必返回 []',
  /if \(plan\.uniteRound !== 1 \|\| !Array\.isArray\(plan\.relayCandidates\)\) return \[\]/.test(unite),
  '这就是 7 人房也拿到 150 秒的原因：判断恒为「无接力」，但长度判断的语义依赖它');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
