// 验证「允许重复选择策略」(allowRepeat) 是否同样控制 AI 的选策略逻辑。
//
// 规则：开关打开后，AI 不再软避让队友已选的盟约（SOFT_BAND_RESERVE 从 1/4 提到 1），
// 和玩家一样可以选到重复的策略；关闭时保持原来的 1/4 软预留。
//   node test\bot-allow-repeat.mjs
import fs from 'node:fs';
import { botPickBand } from '../node-1/server/match/bot.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

// ── 1. 源码契约 ──
console.log('=== 源码：AI 选策略受 allowRepeat 控制 ===\n');
const botJs = fs.readFileSync('node-1/server/match/bot.js', 'utf8');
check('★ SOFT_BAND_RESERVE 在 allowRepeat 时被跳过',
  /const reserve = m\.allowRepeat === true \? 1 : SOFT_BAND_RESERVE;/.test(botJs));
check('★ 权重计算里用的是 reserve 而不是硬编码常量',
  /w \* reserve/.test(botJs));
check('关闭时仍是 1/4 软预留（原行为不变）',
  /SOFT_BAND_RESERVE = 0\.25/.test(botJs));

// ── 2. 行为：造两次抽选，比较「选到与队友相同盟约」的概率 ──
console.log('\n=== 行为：AI 抽到重复盟约的概率 ===\n');

// 造一个最小 GameData / Match：只有 2 个盟约，A 已被队友占用
function makeWorld({ allowRepeat }) {
  const BANDS = ['band_a', 'band_b'];
  const BONDS = { band_a: ['bond_x'], band_b: ['bond_y'] };
  const gd = {
    bandIds: () => BANDS,
    defaultBandId: 'band_a',
    band: (id) => ({ desc: '' }),
    bandBondIds: (id) => BONDS[id] || [],
    modeInactiveBonds: new Set(),
    startLp: () => 20,     // 相同 LP → 相同基础权重，差异只来自预留
  };
  const teammate = { playerId: 'teammate', bandId: 'band_a', alive: true };
  const ps = { playerId: 'bot', gd };
  let seed = 0;
  const m = {
    allowRepeat,
    gd,
    isSolo: false,
    alivePlayers: () => [teammate, ps],
    rngBots: () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; },
  };
  return { m, ps };
}

function sample(allowRepeat, n = 20000) {
  const { m, ps } = makeWorld({ allowRepeat });
  m.rngBots = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();
  let dup = 0;
  for (let i = 0; i < n; i++) if (botPickBand(m, ps) === 'band_a') dup++;
  return dup / n;
}

const off = sample(false);
const on = sample(true);
console.log(`  allowRepeat=false → 选到队友已占盟约的比例 ${(off * 100).toFixed(1)}%`);
console.log(`  allowRepeat=true  → 选到队友已占盟约的比例 ${(on * 100).toFixed(1)}%`);

check('★ 关闭时 AI 明显避让（< 40%）', off < 0.40, `${(off * 100).toFixed(1)}%`);
check('★ 打开时 AI 不再避让（显著更高）', on > off + 0.15, `${(on * 100).toFixed(1)}% vs ${(off * 100).toFixed(1)}%`);
check('★ 打开后接近「不避让」的水平（约 50%）', Math.abs(on - 0.5) < 0.08, `${(on * 100).toFixed(1)}%`);

// ── 3. 调用链：AI 的其它避让入口也被 allowRepeat 放行 ──
console.log('\n=== 调用链 ===\n');
const phases = fs.readFileSync('node-1/server/match/match/phases.js', 'utf8');
const ioleta = fs.readFileSync('node-1/server/match/botIoleta.js', 'utf8');
check('★ scheduleBandBot 的重试条件用 bandTaken（allowRepeat 时恒 false）',
  /for \(let k = 0; k < 8 && this\.bandTaken\(id, ps\.playerId\)/.test(phases));
check('★ bandTaken 本身受 allowRepeat 控制',
  /bandTaken\(bandId, playerId\) \{\s*\n\s*if \(this\.allowRepeat\) return false;/.test(phases));
check('IOLETA 机器人的偏好判断也走 bandTaken',
  /!m\.bandTaken\(id, ps\.playerId\)/.test(ioleta));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
