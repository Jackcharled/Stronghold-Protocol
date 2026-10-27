// 鸭爵叠加「补抽」必须只在开关打开时生效
//
//   node test/ducklord-refill-isolation.test.js
//
// 维护者 2026-10-27 要求：把叠加从「撞到已选就跳过」改成「补抽别的目标」，
// 但**必须只在开启 stackDuckLord 时才有影响**。
//
// 这里锁三条：
//   1. `ctx.gd.stackDuckLord !== true` 或只有 1 个持有者 → duckGlobal 直接走 duckReplace（上游原路），
//      不进补抽循环。
//   2. `duckPicks` 不传 exclude / 传空 Set / 传 null 时，输出与「改动前逻辑」逐字节相同
//      （随机流、顺序、enemyKey 全一致）—— 这是不叠加时行为不变的硬保证。
//   3. 传了非空 exclude 时，被排除的槽位不会再被选中。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { duckPicks } from '../server/sim/content/bands/meta.js';
import { createRng } from '../server/sim/rng.js';
import { getData } from '../server/data.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const enemies = getData().enemies || {};
const gd = { enemy: (k) => enemies[k] || null };
const params = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/versions/act1autochess/bands.json'), 'utf8')).band_ducklord.params;

const makeWave = (n) => Array.from({ length: n }, (_, i) => ({ actionIndex: i, enemyKey: 'enemy_1007_slime', time: i, routeIndex: 0, count: 1 }));

/** 改动前的 duckPicks（无 exclude 概念），作为基准。 */
function duckPicksBefore(gd2, rng, base, p) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',').map((s) => s.trim()).filter(Boolean));
  const notOwn = (s) => !s || s.tag === 'bounty' || s.tag === 'duck';
  const ducks = list(p.enemylist).filter((k) => gd2.enemy(k));
  if (!ducks.length || !Array.isArray(base)) return [];
  const want = Math.trunc(p.min) + rng.int(Math.trunc(p.max) - Math.trunc(p.min) + 1);
  if (want <= 0) return [];
  const flat = [];
  const seen = new Map();
  let pos = -1;
  for (let i = 0; i < base.length; i++) {
    const s = base[i];
    if (notOwn(s)) continue;
    pos++;
    const action = Number.isInteger(s.actionIndex) ? s.actionIndex : `#${pos}`;
    const cnt = Math.max(1, s.count || 1);
    const k0 = seen.get(action) ?? 0;
    seen.set(action, k0 + cnt);
    for (let k = 0; k < cnt; k++) flat.push({ i, action, k: k0 + k, t: s.time || 0 });
  }
  flat.sort((a, b) => a.t - b.t || a.i - b.i || a.k - b.k);
  const n = flat.length;
  const ok = flat.filter((f, j) => {
    const s = base[f.i];
    const e = gd2.enemy(s.enemyKey);
    const frac = n > 1 ? j / (n - 1) : 0;
    return !s.tag && e && e.rank !== 'BOSS' && !e.notCountInTotal && e.stats?.motion !== 'FLY'
      && frac >= p.minweight - 1e-9 && frac <= p.maxweight + 1e-9;
  });
  return rng.shuffle(ok).slice(0, want).map((f) => ({ action: f.action, k: f.k, enemyKey: rng.pick(ducks) }));
}

test('未开启叠加（不传 exclude）时，duckPicks 与改动前逐字节相同', () => {
  let compared = 0;
  for (const n of [4, 10, 20, 40, 60]) {
    const wave = makeWave(n);
    for (let s = 0; s < 400; s++) {
      const seed = (90000 + s * 2654435761) >>> 0;
      const before = JSON.stringify(duckPicksBefore(gd, createRng(seed), wave, params));
      // 三种「未开启」写法都必须一致
      assert.equal(JSON.stringify(duckPicks(gd, createRng(seed), wave, params, {})), before, `波次 ${n} seed ${seed}（不传）`);
      assert.equal(JSON.stringify(duckPicks(gd, createRng(seed), wave, params, { exclude: null })), before, `波次 ${n} seed ${seed}（null）`);
      assert.equal(JSON.stringify(duckPicks(gd, createRng(seed), wave, params, { exclude: new Set() })), before, `波次 ${n} seed ${seed}（空 Set）`);
      compared += 3;
    }
  }
  assert.ok(compared > 1000, `样本量应足够，实际 ${compared}`);
});

test('传了非空 exclude 时才会改变结果（补抽确实生效）', () => {
  const wave = makeWave(40);
  let differ = 0, tested = 0;
  for (let s = 0; s < 800; s++) {
    const seed = (7777 + s * 104729) >>> 0;
    const a = duckPicks(gd, createRng(seed), wave, params, {});
    if (!a.length) continue;
    // 用真实抽中的槽位作为 exclude —— 候选池只含位置 60%-99% 那段，随手编的 '0#0' 不在里面
    const ex = new Set([`${a[0].action}#${a[0].k}`]);
    const b = duckPicks(gd, createRng(seed), wave, params, { exclude: ex });
    tested++;
    if (JSON.stringify(a) !== JSON.stringify(b)) differ++;
  }
  assert.ok(tested > 100, `有效样本应足够，实际 ${tested}`);
  assert.equal(differ, tested, '每一次有效样本都应该因 exclude 而改变');
});

test('被 exclude 的槽位绝不会再次出现', () => {
  const wave = makeWave(40);
  for (let s = 0; s < 300; s++) {
    const seed = (4242 + s * 7919) >>> 0;
    const first = duckPicks(gd, createRng(seed), wave, params, {});
    if (!first.length) continue;
    const ex = new Set(first.map((pk) => `${pk.action}#${pk.k}`));
    const second = duckPicks(gd, createRng(seed), wave, params, { exclude: ex });
    for (const pk of second) {
      assert.ok(!ex.has(`${pk.action}#${pk.k}`), `槽位 ${pk.action}#${pk.k} 被重复选中`);
    }
  }
});

test('源码结构：未开启时走 duckReplace 并 return，不进补抽循环', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/sim/content/bands/meta.js'), 'utf8');
  // stack 判定必须同时要求开关为 true 与多持有者
  assert.match(src, /const stack = ctx\.gd\.stackDuckLord === true && holders\.length > 1;/);
  // 未开启分支必须 duckReplace 并 return（参数里有嵌套括号，不能用 [^)]*）
  const stackBlock = src.slice(src.indexOf('if (!stack) {'), src.indexOf('if (!stack) {') + 400);
  assert.match(stackBlock, /duckReplace\(/, '未开启分支必须调用 duckReplace');
  assert.match(stackBlock, /return;/, '未开启分支必须 return');
  // 补抽循环必须在 stack 分支之后（即只有开启才会执行到）
  const iStack = src.indexOf('if (!stack) {');
  const iLoop = src.indexOf('const taken = i === 0 ? null : new Set(bySlot.keys());');
  assert.ok(iStack > 0 && iLoop > iStack, '补抽循环必须在 "if (!stack) return" 之后');
  // 第 0 路不传 exclude（保持与上游同一条随机流）
  assert.match(src, /const taken = i === 0 \? null : new Set\(bySlot\.keys\(\)\);/);
});
