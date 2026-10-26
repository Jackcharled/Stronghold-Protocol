// 验证模型加载失败后的重试策略：不能「重试几次就永久放弃」。
// 玩家反馈「某个干员一直只有头像没有模型」—— 旧实现 4 次重试约 40 秒后彻底放弃，
// 之后只能靠素材变更或切标签页触发 retryAssets，玩家一直盯着屏幕就永远看不到模型。
//   node test\model-retry-backoff.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const src = fs.readFileSync('node-1/public/js/render/units.js', 'utf8');

// 从源码取常量
const pickArr = (name) => {
  const m = src.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
  return m ? m[1].split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : null;
};
const pickNum = (name) => {
  const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
  return m ? Number(m[1]) : null;
};

const FAST = pickArr('SPINE_RETRY_MS');
const MAX = pickNum('SPINE_RETRY_MAX_MS');
check('取到 SPINE_RETRY_MS', Array.isArray(FAST) && FAST.length > 0, JSON.stringify(FAST));
check('取到 SPINE_RETRY_MAX_MS', Number.isFinite(MAX), String(MAX));

// 复刻代码里的等待计算
const waitFor = (tries) => (tries < FAST.length
  ? FAST[tries]
  : Math.min(MAX, FAST[FAST.length - 1] * (tries - FAST.length + 1)));

console.log('\n第 N 次失败后的等待时间：');
for (const t of [0, 1, 2, 3, 4, 5, 6, 8, 12, 30]) {
  console.log(`  第 ${String(t + 1).padStart(2)} 次 → ${waitFor(t)} ms`);
}

// ★ 核心：不能有「次数上限」
check('★ 源码里不再有「重试次数用尽就放弃」的判断',
  !/this\._spineTries\s*<\s*SPINE_RETRY_MS\.length\)\s*this\._retryAt/.test(src),
  /this\._spineTries\s*<\s*SPINE_RETRY_MS\.length\)\s*this\._retryAt/.test(src) ? '仍有旧逻辑' : '');

check('★ 失败后无条件设置下次重试时间', /this\._retryAt = nowMs\(\) \+ wait;/.test(src));

check('★ 无限次重试：第 100 次失败仍然会重试', Number.isFinite(waitFor(100)) && waitFor(100) > 0, `${waitFor(100)} ms`);
check('★ 长期退避有上限（不会越来越慢到永久不重试）', waitFor(100) <= MAX, `${waitFor(100)} <= ${MAX}`);
check('★ 退避封顶后仍在 1 分钟内重试（玩家能很快看到模型）', MAX <= 60000, `${MAX} ms`);
check('前期快速重试保留（网络抖动几秒内恢复）', FAST[0] <= 2000, `首档 ${FAST[0]} ms`);

// 累计时间：旧实现 4 次共约 40 秒后放弃；新实现 60 秒内至少再试 3 次
let t = 0;
let n = 0;
while (t < 60000) { t += waitFor(n); n++; }
check('★ 60 秒内至少重试 5 次（旧实现 4 次后就停了）', n >= 5, `实际 ${n} 次`);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
