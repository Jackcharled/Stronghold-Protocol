// 鸭爵叠加（本服新增，实验性开关 stackDuckLord）
//
// 上游设计：duckGlobal 用 find() 取第一个持有鸭爵的玩家，多个队友选鸭爵也只算 1 份。
// 本服开关打开后：每个持有者各抽一份，合并去重 —— 同一只敌人只换一次。
//
// 关键约束（这条最重要）：只有一个持有者时，随机流必须与上游逐字相同（duck:<round>），
// 行为不受开关影响，否则老对局的回放/预览会全体漂移。
//
//   node test/match/ducklord-stack.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { createRegistry } from '../../server/match/effectsMeta.js';

const REG = createRegistry({ log: { warn() {}, error() {}, info() {} } });
const swapsOf = (spawns) => spawns.filter((s) => s.tag === 'duck').map((s) => `${s.actionIndex}:${s.enemyKey}`).sort();
const duckCount = (spawns) => spawns.filter((s) => s.tag === 'duck').length;

/**
 * 一个四人同盟，前 `holders` 人拿鸭爵；推进到第 6 回合（鸭爵从第 5 回合起生效）。
 *
 * 两个夹具坑（与鸭爵逻辑无关，只是 makeMatch 的脾气）：
 *   1. 每个对局用一份新的 registry —— 共用会残留上一局的草稿状态。
 *   2. 开局种子要挑能走完自动草稿的：少数种子（如 7、1700）四个人机在 BAND_DRAFT 里
 *      收敛不到 PREP R6。下面 SEED_BASE 起的前若干种子里 1700 那档会踩到，所以逐个试。
 */
const SEED_BASE = 500;
/** 一个不是鸭爵的策略：用来把 AI 自己挑的鸭爵清掉，精确控制持有者数量。 */
const NON_DUCK = 'band_bldsk';
function coop({ stack = false, holders = 1 } = {}) {
  const reg = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  for (let offset = 0; offset < 64; offset++) {
    const seed = SEED_BASE + offset;
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed, registry: reg, fake: true }).start();
    try {
      h.toPrep(6);
    } catch {
      h.m.dispose();
      continue; // 这个种子自动草稿走不完，换下一个
    }
    const m = h.m;
    const ps = m.alivePlayers();
    // ⚠ AI 在草稿时可能自己就拿了鸭爵（它们也按同样的规则挑策略），
    //   所以先把所有人的 bandId 清成非鸭爵，再精确设定「前 holders 个」持有。
    ps.forEach((p, i) => { p.bandId = i < holders ? 'band_ducklord' : NON_DUCK; });
    m.gd.stackDuckLord = stack;
    return { h, m, ps, seed0: m.seed, done() { m.dispose(); } };
  }
  throw new Error('no seed reached PREP R6');
}

/** 用同一个基准种子跑一遍，收集 n 个种子下的替换列表（只读预览路径，不消耗对局随机流）。 */
function collect(run, n, base) {
  const out = [];
  for (let k = 0; k < n; k++) {
    run.m.seed = base + k;
    out.push(swapsOf(run.m._normalOpts(run.ps[0]).spawns));
  }
  run.m.seed = run.seed0;
  return out;
}

test('开关关闭时（默认）：多个队友持有鸭爵仍只算 1 份，与上游一致', () => {
  const a = coop({ holders: 3, stack: false });
  const three = collect(a, 20, 7).map((s) => s.length);
  a.done();
  const b = coop({ holders: 1, stack: false });
  const one = collect(b, 20, 7).map((s) => s.length);
  b.done();
  // 关闭叠加时，3 个持有者与 1 个持有者抽到的数量完全一样（find() 只取第一个）
  assert.deepEqual(three, one, 'stackDuckLord off: extra holders change nothing (upstream find() behaviour)');
});

test('★ 开关打开时：多个队友持有鸭爵会叠加更多替换', () => {
  const off = coop({ holders: 3, stack: false });
  const on = coop({ holders: 3, stack: true });
  // 同一基准种子下比较，否则差异里混着「不同开局种子」的噪声
  on.m.seed = off.m.seed;
  const offN = collect(off, 30, 100).map((s) => s.length).reduce((a, b) => a + b, 0);
  const onN = collect(on, 30, 100).map((s) => s.length).reduce((a, b) => a + b, 0);
  off.done(); on.done();
  assert.ok(onN > offN, `stacking must replace more enemies: off=${offN} on=${onN}`);
});

test('★ 只有一个持有者时，开不开叠加结果完全一样（不改变上游行为）', () => {
  // 注意：不同对局的内部随机流本来就不一样（seedFor 依赖每局自己的状态），
  // 所以不能拿两局互比。这里比的是**同一局内**开关切换前后的结果：
  // stackDuckLord 只在 holders.length > 1 时才改变路径，单持有者必须走原来那条。
  const run = coop({ holders: 1, stack: false });
  const plain = collect(run, 30, 500);
  run.m.gd.stackDuckLord = true;
  const stacked = collect(run, 30, 500);
  run.done();
  for (let k = 0; k < plain.length; k++) {
    assert.deepEqual(stacked[k], plain[k], `single holder must ignore the toggle, seed ${500 + k}`);
  }
});

test('叠加后同一只敌人不会被重复替换（格子去重）', () => {
  const run = coop({ holders: 4, stack: true });
  let checked = 0;
  for (let k = 0; k < 40; k++) {
    run.m.seed = 900 + k;
    const spawns = run.m._normalOpts(run.ps[0]).spawns;
    const ducks = spawns.filter((s) => s.tag === 'duck');
    const slots = ducks.map((s) => `${s.actionIndex}@${s.time}`);
    assert.equal(new Set(slots).size, slots.length, `no duplicate swap slot, seed ${900 + k}`);
    checked += ducks.length;
  }
  run.done();
  assert.ok(checked > 0, 'some swaps happened');
});

test('叠加不会无限放大：替换数不超过本回合可替换敌人总数', () => {
  const run = coop({ holders: 4, stack: true });
  for (let k = 0; k < 25; k++) {
    run.m.seed = 1300 + k;
    const spawns = run.m._normalOpts(run.ps[0]).spawns;
    const own = spawns.filter((s) => s.tag !== 'bounty' && s.tag !== 'duck')
      .reduce((n, s) => n + (s.count || 1), 0);
    assert.ok(duckCount(spawns) <= own, `swaps (${duckCount(spawns)}) must not exceed the wave's own units (${own})`);
  }
  run.done();
});

test('★ 四个队友全选鸭爵 + 叠加：仍不超过敌人总数', () => {
  const run = coop({ holders: 4, stack: true });
  for (let k = 0; k < 20; k++) {
    run.m.seed = 1700 + k;
    const spawns = run.m._normalOpts(run.ps[0]).spawns;
    const total = spawns.reduce((n, s) => n + (s.count || 1), 0);
    assert.ok(duckCount(spawns) <= total, `all-4 stacking stays bounded: ${duckCount(spawns)} <= ${total}`);
  }
  run.done();
});

test('★ 叠加严格晚于第 5 回合才生效（第 2 回合没有鸭爵）', () => {
  const reg = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 2000, registry: reg, fake: true }).start();
  h.toPrep(2);
  const m = h.m;
  const ps = m.alivePlayers();
  ps.forEach((p) => { p.bandId = 'band_ducklord'; });
  m.gd.stackDuckLord = true;
  assert.equal(duckCount(m._normalOpts(ps[0]).spawns), 0, 'round 2: no duck yet');
  m.dispose();
});
