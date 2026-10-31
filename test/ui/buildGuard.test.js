// test/ui/buildGuard.test.js — public/js/ui/buildGuard.js: the "this page runs an outdated build" guard that lets a
// deploy reach a tab that was already open (a page keeps its imported ES modules for its whole lifetime — the reason a
// client-only battle fix stayed invisible on the reporting player's page).
//
// Review-driven contract: a check that cannot read a build NEVER reloads, a new build is acted on only after two checks
// in a row agree, and a match on screen is never thrown away — the guard waits for it (and its settlement) to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBuildOnce, startBuildGuard, fetchBuild, updateHintAllowed, BUILD_CHECK_MS, BUILD_FETCH_TIMEOUT_MS } from '../../public/js/ui/buildGuard.js';
import { PHASE } from '../../shared/constants.js';

/** A fake fetch answering /healthz with `build` (null → the frame carries none). */
const fetchOf = (build) => async (url, init) => {
  assert.equal(url, '/healthz');
  assert.equal(init.cache, 'no-store');
  return { ok: true, status: 200, json: async () => ({ ok: true, build }) };
};

test('fetchBuild: the tag, or null when unreachable / not reported / too slow', async () => {
  assert.equal(await fetchBuild(fetchOf('aaa')), 'aaa');
  assert.equal(await fetchBuild(async () => { throw new Error('offline'); }), null);
  assert.equal(await fetchBuild(async () => ({ ok: false, status: 503, json: async () => ({}) })), null);
  assert.equal(await fetchBuild(fetchOf(null)), null);
  // a request that never answers must not keep the guard waiting forever
  const t0 = Date.now();
  assert.equal(await fetchBuild(() => new Promise(() => {}), { timeoutMs: 20 }), null);
  assert.ok(Date.now() - t0 < BUILD_FETCH_TIMEOUT_MS, 'gives up on its own timeout');
});

test('checkBuildOnce: first sighting, unchanged, changed, and unknown when the server says nothing', async () => {
  assert.deepEqual(await checkBuildOnce({ fetchFn: fetchOf('aaa') }), { status: 'first', build: 'aaa' });
  assert.deepEqual(await checkBuildOnce({ fetchFn: fetchOf('aaa'), known: 'aaa' }), { status: 'current', build: 'aaa' });
  assert.deepEqual(await checkBuildOnce({ fetchFn: fetchOf('bbb'), known: 'aaa' }), { status: 'new', build: 'bbb' });
  assert.deepEqual(await checkBuildOnce({ fetchFn: async () => { throw new Error('offline'); }, known: 'aaa' }), { status: 'unknown', build: null });
});

/** A guard driven by hand: run the interval callback on demand. */
function manual({ inMatch = false } = {}) {
  const ticks = [];
  const calls = { reload: 0, stale: [] };
  let build = 'aaa';
  let reachable = true;
  let busy = inMatch;
  const guard = startBuildGuard({
    fetchFn: async () => {
      if (!reachable) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ build }) };
    },
    reload: () => { calls.reload++; },
    inMatch: () => busy,
    setInterval: (fn) => { ticks.push(fn); return ticks.length; },
    clearInterval: () => {},
    onStale: (info) => calls.stale.push(info),
  });
  return {
    calls, ticks, guard,
    setBuild: (b) => { build = b; },
    setReachable: (b) => { reachable = b; },
    setInMatch: (b) => { busy = b; },
    /** run the interval callback and let its await settle */
    tick: async () => { for (const fn of ticks) fn(); await new Promise((r) => setTimeout(r, 0)); },
  };
}

test('startBuildGuard: records this page\'s build in memory, reloads once on a NEW build (after two agreeing checks)', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));                  // the immediate first check
  assert.equal(m.guard.known(), 'aaa');
  assert.equal(m.calls.reload, 0);
  await m.tick();
  assert.equal(m.calls.reload, 0, 'same build → no reload');
  m.setBuild('bbb');
  await m.tick();
  assert.equal(m.calls.reload, 0, 'one sighting is not enough: a half-copied deploy must not ping-pong the page');
  assert.equal(m.guard.stale(), false);
  await m.tick();
  assert.equal(m.calls.reload, 1, 'the same new build twice → the page reloads');
  assert.deepEqual(m.calls.stale, [{ build: 'bbb', known: 'aaa', waiting: false }]);
  await m.tick();
  assert.equal(m.calls.reload, 1, 'the guard stopped after reloading');
  assert.equal(m.guard.stale(), true);
});

test('reset(): stops reporting stale but KEEPS watching (2026-10-31, "大厅里也要提示更新")', async () => {
  // 维护者要求：更新后，已经建了房、或者还停在大厅里的人也要看到「刷新换新版本」的提示。
  // 以前 main.js 在「离开房间」时直接 buildGuard.stop()，于是这些人永远收不到提示。
  // 现在改成 reset()：清掉刚结束那一局的提示，但**继续监控**。
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));      // 首次检查：基准 = aaa
  m.setBuild('bbb');
  await m.tick();                                  // 一次观测，还不够
  await m.tick();                                  // 两次一致 → 判定 stale
  assert.equal(m.guard.stale(), true);
  assert.equal(m.calls.stale.length, 1);

  // 离开房间：reset 清掉状态，但监控还在。
  // ⚠ 这里要先让在途的 check() 落定：tick() 只是触发，await 的是微任务，
  //   而 check 内部有多个 await —— 不先 flush 就可能读到上一轮尚未写完的 stale。
  m.guard.reset();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(m.guard.stale(), false, 'reset 之后不再报告 stale');

  // 服务器仍是新版本：再检查两轮应该**重新**判定为 stale 并再次通知
  await m.tick();
  await m.tick();
  assert.equal(m.guard.stale(), true, 'reset 之后仍在监控：新版本会被重新发现');
  assert.equal(m.calls.stale.length, 2, '第二次 stale 也要通知（大厅里的横幅靠它）');
});

test('reset() after stop() is a no-op (a stopped guard never comes back)', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));
  m.guard.stop();
  m.guard.reset();
  m.setBuild('bbb');
  await m.tick();
  assert.equal(m.guard.stale(), false, 'stop 之后不能再判定 stale');
  assert.equal(m.calls.stale.length, 0);
});
test('startBuildGuard: a NEW build that is then not served twice is dropped (rolling deploy / reverts)', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));
  m.setBuild('bbb');
  await m.tick();
  m.setBuild('aaa');                                           // the fleet rolled back to this page's build
  await m.tick();
  m.setBuild('bbb');
  await m.tick();
  assert.equal(m.calls.reload, 0, 'never saw the same new build twice in a row');
});

test('startBuildGuard: an unreadable /healthz never reloads — not even after a new build was seen', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));
  m.setBuild('bbb');
  await m.tick();                                              // one sighting of the new build
  m.setReachable(false);                                       // …and now the server is restarting
  await m.tick();
  await m.tick();
  assert.equal(m.calls.reload, 0, 'a failed check is unknown, never a reason to reload');
  assert.equal(m.guard.stale(), false);
  m.setReachable(true);
  await m.tick();
  assert.equal(m.calls.reload, 0, 'the sightings must be consecutive: the failures in between reset the count');
  await m.tick();
  assert.equal(m.calls.reload, 1, 'two checks in a row agree → reload');
});

test('startBuildGuard: a match on screen is never thrown away — it waits for the match (and its settlement) to end', async () => {
  const m = manual({ inMatch: true });
  await new Promise((r) => setTimeout(r, 0));
  m.setBuild('bbb');
  await m.tick();
  await m.tick();
  assert.equal(m.calls.reload, 0, 'in a match: the reload waits');
  assert.equal(m.guard.stale(), true, 'the staleness is remembered');
  assert.deepEqual(m.calls.stale, [{ build: 'bbb', known: 'aaa', waiting: true }], 'the UI is told to offer a reload');
  await m.tick();
  assert.equal(m.calls.reload, 0);
  m.setInMatch(false);                                         // back in the lobby / room: the match is over
  await m.tick();
  assert.equal(m.calls.reload, 1, 'once nothing is at stake the page reloads');
});

test('startBuildGuard: stop() ends the watch', async () => {
  const m = manual();
  await new Promise((r) => setTimeout(r, 0));
  m.guard.stop();
  m.setBuild('bbb');
  await m.tick();
  await m.tick();
  assert.equal(m.calls.reload, 0);
  assert.equal(m.guard.stale(), false);
  assert.equal(BUILD_CHECK_MS, 60_000);
});

test('onHealth: told every /healthz body a check reads — what else the page reads of the server before any hello (DESIGN §32 P1a)', async () => {
  const bodies = [];
  const fetchFn = async () => ({ ok: true, json: async () => ({ build: 'aaa', content: { vanilla: 'c'.repeat(64), sets: 0, plugins: 2 } }) });
  assert.equal(await fetchBuild(fetchFn, { onHealth: (b) => bodies.push(b) }), 'aaa');
  assert.deepEqual(bodies.map((b) => b.content.plugins), [2]);
  assert.equal(await fetchBuild(fetchFn, { onHealth: () => { throw new Error('listener trouble'); } }), 'aaa', 'its listener cannot break the check');
  await checkBuildOnce({ fetchFn, onHealth: (b) => bodies.push(b) });
  assert.equal(bodies.length, 2);
  const g = startBuildGuard({ fetchFn, reload: () => {}, setInterval: () => 1, clearInterval: () => {}, onHealth: (b) => bodies.push(b) });
  for (let i = 0; i < 20 && bodies.length < 3; i++) await new Promise((r) => setTimeout(r, 1));
  g.stop();
  assert.equal(bodies.length, 3, 'the guard\'s first check hands it over');
  const main = (await import('node:fs')).readFileSync(new URL('../../public/js/main.js', import.meta.url), 'utf8');
  const callback = /onHealth:\s*(\(h\) => \{[\s\S]*?\n\s*\}),/.exec(main)?.[1];
  assert.ok(callback, 'main wires the health callback');
  let state = { installedPlugins: 0, installedNotices: false };
  let writes = 0;
  // Execute the actual callback with a small store; changes in formatting do not change this contract.
  const onHealth = new Function('pluginCount', 'store', `return (${callback});`)(
    (content) => Number.isInteger(content?.plugins) && content.plugins > 0 ? content.plugins : 0,
    { get: () => state, set: (patch) => { state = { ...state, ...patch }; writes++; } },
  );
  onHealth({ content: { plugins: 2, notices: true } });
  assert.deepEqual(state, { installedPlugins: 2, installedNotices: true });
  onHealth({ content: { plugins: 2, notices: true } });
  assert.equal(writes, 1, 'unchanged hints do not notify subscribers');
  onHealth({ content: { notices: true } });
  assert.deepEqual(state, { installedPlugins: 0, installedNotices: true }, 'language-only notices reach the title');
  onHealth({});
  assert.deepEqual(state, { installedPlugins: 0, installedNotices: false }, 'a notice-free server clears the hint');
});

// ---------------------------------------------------------------------------------------------------
// 2026-10-31 维护者要求：「服务器更新需要刷新的提示，**对局中不要弹出**，
// 只有结算界面、房间准备阶段、大厅的时候弹出。」
// ---------------------------------------------------------------------------------------------------

test('updateHintAllowed: 对局中（任何阶段）都不提示，只在大厅/房间/结算提示', () => {
  // 大厅、房间准备阶段、标题页：不是对局，提示照常
  assert.equal(updateHintAllowed('lobby', undefined), true, '大厅');
  assert.equal(updateHintAllowed('room', undefined), true, '房间准备阶段');
  assert.equal(updateHintAllowed('title', undefined), true, '标题页');
  // 结算界面：RESULT 时 selectRoute 仍是 'game'，靠 phase 放行
  assert.equal(updateHintAllowed('game', PHASE.RESULT), true, '结算界面（RESULT）');
  // 对局中：除了 RESULT 一律挡住
  for (const ph of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.BATTLE_CHECK, PHASE.PREP, PHASE.ROUND_START,
    PHASE.SP_DRAFT, PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE, PHASE.SETTLE]) {
    assert.equal(updateHintAllowed('game', ph), false, `对局中不提示：${ph}`);
  }
  // 对局刚开头 m.public 还没到（route 已是 game、phase 还是 LOBBY）：也算对局中
  assert.equal(updateHintAllowed('game', PHASE.LOBBY), false, 'm.public 未到但已在开局');
  assert.equal(updateHintAllowed('game', undefined), false, '没有 phase 但已在 game 路由');
});

test('connBanner 用的是 hintAllowed：对局中横幅不画，sp-conn 也不亮（toast 不会被白压下去）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../public/js/ui/connBanner.js', import.meta.url), 'utf8');
  // 判定函数必须被真正用上，而不是只 import 进来
  assert.match(src, /updateHintAllowed\(route, phase\)/, '横幅必须用 updateHintAllowed 决定画不画');
  assert.match(src, /const staleShown = stale && hintAllowed/, '显示条件 = 是旧版本 且 这一屏允许提示');
  // 两个早退分支和 sp-conn 都要用 staleShown，不能用裸 stale
  assert.match(src, /bannerVisible\(conn, entered, restoring, staleShown\)/, 'sp-conn 必须跟随 staleShown');
  assert.match(src, /conn\.status === 'online' && !restoring && !staleShown/, '在线且允许提示时才继续渲染');
  assert.match(src, /conn\.status === 'online' && staleShown/, '横幅由 staleShown 把关');
  // 反过来：不能残留用裸 stale 做显示判断（那会绕过闸门）
  assert.doesNotMatch(src, /=== 'online' && stale\)/, '不能残留用裸 stale 判断显示');
});

test('resume(): 离开房间不停表、也不清 stale —— 大厅/结算该看到的提示必须还在', async () => {
  // 这是「对局中不弹、离开后要弹」的关键：如果 sp-room-left 把 stale 清掉，
  // 玩家要在大厅里再干等 2 次检查（约 2 分钟）才能重新看到提示。
  const m = manual({ inMatch: true });
  await new Promise((r) => setTimeout(r, 0));
  m.setBuild('bbb');
  await m.tick();
  await m.tick();
  assert.equal(m.guard.stale(), true, '对局中已判定为旧版本');
  assert.equal(m.calls.reload, 0, '对局中绝不自动刷新');
  // 对局结束：现在改走 resume()，而不是 reset()
  m.setInMatch(false);
  m.guard.resume();
  assert.equal(m.guard.stale(), true, 'resume 不能把「已更新」这个结论清掉');
  // 且监控还在：之后服务器再换一次版本照样能发现
  m.setBuild('ccc');
  await m.tick();
  await m.tick();
  assert.equal(m.guard.known(), 'aaa', 'known 没被当成新基准（否则以后再换版就发现不了）');
});

test('main.js: sp-room-left 走 resume，不再 reset + 清 buildStale', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../public/js/main.js', import.meta.url), 'utf8');
  const block = /addEventListener\('sp-room-left'[\s\S]*?\}\);/.exec(src)?.[0];
  assert.ok(block, 'main.js 仍然监听 sp-room-left');
  assert.match(block, /buildGuard\.resume\?\.\(\)/, '离开房间只恢复监控，不重置判定');
  assert.doesNotMatch(block, /buildGuard\.reset/, '不能再用 reset（会把大厅里该出现的提示一起抹掉）');
  assert.doesNotMatch(block, /buildStale: false/, '不能清 buildStale（同上）');
});
