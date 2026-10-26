// 回归：stackDuckLord 开关**只**影响鸭爵，其他一切照旧。
//
// 这是「只影响鸭爵」的证据测试：把开关拨到 true，然后逐项比对与 false 时是否完全相同。
// 任何一条不同，都说明叠加泄漏到了别的机制上。
//
//   node test/match/ducklord-stack-isolation.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA } from './harness.js';
import { createRegistry } from '../../server/match/effectsMeta.js';

const REG = createRegistry({ log: { warn() {}, error() {}, info() {} } });
const NON_DUCK = 'band_bldsk';

/**
 * 四人同盟，推进到第 6 回合。
 *
 * 为什么不用扩展房（5–20 人）：测试夹具的 toPrep 驱动不了 capacityExperiment 房间 ——
 * AI 草稿在 BAND_DRAFT 收敛不了，任何种子都到不了 PREP R6（这与叠加功能无关）。
 * 隔离性本身和房间大小无关：直接拨 gd.stackDuckLord 就能验证「开关只影响鸭爵」。
 */
function room8() {
  const reg = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  for (let off = 0; off < 64; off++) {
    const seed = 500 + off;
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed, registry: reg, fake: true }).start();
    try { h.toPrep(6); } catch { h.m.dispose(); continue; }
    return { h, m: h.m, ps: h.m.alivePlayers(), done() { h.m.dispose(); } };
  }
  throw new Error('no seed reached PREP R6');
}

/** 一局的"指纹"：和鸭爵无关的所有可观察状态。 */
function fingerprint(m, ps) {
  const fp = {};
  // 1) 每人资金、生命、人口、等级、棋盘规模
  fp.economy = ps.map((p) => [p.playerId, p.gold, p.lp, p.shopLevel, p.pieces ? p.pieces.length : 0]);
  // 2) 每人的波次：**敌人总数** 与 **非鸭爵敌人按时间轴展开后的多重集合**。
  //    叠加的语义就是"把更多格子换成鸭爵"，所以非鸭爵敌人的条数会变少 —— 这是功能本身。
  //    真正必须不变的是：总数量、以及哪些时刻来了什么敌人（除被换掉的那些）。
  fp.waves = ps.map((p) => {
    const spawns = m._normalOpts(p).spawns;
    const total = spawns.reduce((n, s) => n + Math.max(1, Number(s.count) || 1), 0);
    const nonDuck = [];
    for (const s of spawns) {
      if (s.tag === 'duck') continue;
      const c = Math.max(1, Number(s.count) || 1);
      const iv = Number(s.interval) || 0;
      for (let j = 0; j < c; j++) nonDuck.push(`${Number(s.time || 0) + j * iv}|${s.enemyKey}|${s.routeIndex}`);
    }
    return { total, nonDuck: nonDuck.sort() };
  });
  // 3) 每人鸭爵数量（允许变化）
  fp.ducks = ps.map((p) => m._normalOpts(p).spawns.filter((s) => s.tag === 'duck').length);
  // 4) 商店内容（shop 的结构随版本不同，能序列化就序列化，取不到就跳过）
  fp.shops = ps.map((p) => {
    const s = p.shop;
    if (!s) return null;
    if (Array.isArray(s)) return s.map((x) => (x && (x.chessId || x.itemId)) || null);
    try { return JSON.stringify(s); } catch { return null; }
  });
  // 5) 策略分配（谁的 bandId 是什么）
  fp.bands = ps.map((p) => p.bandId);
  return fp;
}

/** 只保留"必须不变"的部分：丢掉鸭爵数量，非鸭爵敌人集合是"子集"关系。 */
function invariantPart(fp) {
  return { economy: fp.economy, totals: fp.waves.map((w) => w.total), shops: fp.shops, bands: fp.bands };
}

test('★ 开关只影响鸭爵：经济/商店/策略/敌人总数都不变', () => {
  const r = room8();
  r.ps.forEach((p, i) => { p.bandId = i < 3 ? 'band_ducklord' : NON_DUCK; });
  for (let k = 0; k < 25; k++) {
    r.m.seed = 500 + k;
    r.m.gd.stackDuckLord = false;
    const off = fingerprint(r.m, r.ps);
    r.m.gd.stackDuckLord = true;
    const on = fingerprint(r.m, r.ps);
    // 1) 资金/生命/等级/商店/策略分配：逐字相同
    assert.deepEqual(invariantPart(on), invariantPart(off), `economy/shop/bands unchanged, seed ${500 + k}`);
    // 2) 敌人总数守恒：叠加只替换，不增不减
    assert.deepEqual(on.waves.map((w) => w.total), off.waves.map((w) => w.total), `enemy count conserved, seed ${500 + k}`);
    // 3) 叠加只会换更���或一样多的鸭爵，永远不减少
    for (let i = 0; i < on.ducks.length; i++) assert.ok(on.ducks[i] >= off.ducks[i], `stacking must not replace fewer ducks, seed ${500 + k}`);
    // 4) 非鸭爵敌人种类不变：被换掉的是"格子"，不该冒出新的敌种
    for (let i = 0; i < on.waves.length; i++) {
      const offKinds = new Set(off.waves[i].nonDuck.map((u) => u.split('|')[1]));
      for (const u of on.waves[i].nonDuck) {
        const kind = u.split('|')[1];
        assert.ok(offKinds.has(kind), `enemy kind ${kind} must exist in the original wave, seed ${500 + k}`);
      }
    }
  }
  r.done();
});

test('★ 开关不影响鸭爵以外的策略：没有鸭爵持有者时一切逐字相同', () => {
  const r = room8();
  // 只用非鸭爵策略：一个鸭爵都没有
  const bands = ['band_bldsk', 'band_yu', 'band_mberry'];
  r.ps.forEach((p, i) => { p.bandId = bands[i % bands.length]; });
  for (let k = 0; k < 25; k++) {
    r.m.seed = 500 + k;
    r.m.gd.stackDuckLord = false;
    const a = fingerprint(r.m, r.ps);
    r.m.gd.stackDuckLord = true;
    const b = fingerprint(r.m, r.ps);
    // 没有持有者时，连鸭爵数量都不会变 —— 整份指纹必须完全一致
    assert.deepEqual(b, a, `no duck holder at all: the toggle must change nothing, seed ${500 + k}`);
  }
  r.done();
});

test('★ 开关不影响单人对局（solo 没有同盟、没有鸭爵叠加）', () => {
  const mk = () => {
    const reg = createRegistry({ log: { warn() {}, error() {}, info() {} } });
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, bots: 0, seed: 500, registry: reg, fake: true }).start();
    h.toPrep(6);
    return h;
  };
  const a = mk(), b = mk();
  a.m.gd.stackDuckLord = false;
  b.m.gd.stackDuckLord = true;
  const pa = a.m.alivePlayers()[0], pb = b.m.alivePlayers()[0];
  assert.deepEqual(
    b.m._normalOpts(pb).spawns.map((s) => s.enemyKey),
    a.m._normalOpts(pa).spawns.map((s) => s.enemyKey),
    'solo waves are unaffected by the toggle',
  );
  a.m.dispose(); b.m.dispose();
});

test('★ 默认关闭：不带该选项的房间 stackDuckLord 为 false', () => {
  const reg = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 500, registry: reg, fake: true,
    experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8, allowRepeat: true },
  }).start();
  assert.equal(h.m.stackDuckLord, false, 'omitted option means off');
  assert.equal(h.m.gd.stackDuckLord, false);
  h.m.dispose();
});

test('★ 没开「允许重复选择策略」时，即使写了 stackDuckLord 也不生效', () => {
  const reg = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 500, registry: reg, fake: true,
    // allowRepeat 没开：一支队伍本来就不可能出现两个鸭爵，叠加无从谈起
    experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8, stackDuckLord: true },
  }).start();
  assert.equal(h.m.allowRepeat, false);
  assert.equal(h.m.stackDuckLord, false, 'without allowRepeat the toggle must be inert');
  h.m.dispose();
});

test('★ 普通 4 人房（非扩展房）不受影响', () => {
  const reg = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 500, registry: reg, fake: true }).start();
  assert.equal(h.m.capacityExperiment, false);
  assert.equal(h.m.stackDuckLord, false, 'a 4-player room cannot stack: not an expanded room');
  h.m.dispose();
});

test('★ 鸭爵之外的战斗内容不变（血量缩放、敌人池、阶段回合）', () => {
  const r = room8();
  const pick = (m) => ({
    lastRound: m.gd.mode.lastRound,
    bossRound: m.gd.mode.bossRound,
    spRounds: m.gd.mode.spRounds,
    enemyScale: m.gd.mode.enemyScale,
    bossHp: m.gd.config.bossHpScale,
    shopOdds: m.gd.economy.shopOdds,
    prices: m.gd.economy.upgradePrices,
  });
  r.m.gd.stackDuckLord = false;
  const a = pick(r.m);
  r.m.gd.stackDuckLord = true;
  const b = pick(r.m);
  r.done();
  assert.deepEqual(b, a, 'balance data must be untouched by the toggle');
});
