// 5–20 人容量实验走内容插件 host（worker / 子进程）时，opts 会经 MatchProxy 的
// wireOptions 白名单序列化过去。那份白名单里有 seats 却没有 experimental，
// 于是 worker 里的 Match 拿不到 playerCapacity、回落到默认 4 座，
// 第 5 个座位就直接抛 RangeError（Match.js「seats exceed room capacity」）。
//
// 生产症状（2026-10-26～30，累计 481 次，node-28 独占 338 次）：
//   [host] match WJGP-2-1 could not be created RangeError: Match: seats exceed room capacity
//     at new Match (.../server/match/Match.js:352)
//     at new ContentMatch (.../server/match/host/entry.js:182)
//
// 这个文件只守住「experimental 必须被转发」这一条，以及与上游匹配的键集不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireOptions } from '../../server/match/host/proxy.js';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { DATA } from './harness.js';

const seats = (n) => Array.from({ length: n }, (_, i) => ({
  seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true,
}));

test('wireOptions forwards experimental — without it the worker match falls back to 4 seats', () => {
  const experimental = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 };
  const wire = wireOptions({ roomCode: 'ABCD', mode: 'coop', seats: seats(5), experimental });
  assert.deepEqual(wire.experimental, experimental, 'experimental must survive the wire');

  // 只有把 experimental 带过去，worker 侧的 Match 才认 8 座
  const opts = { mode: 'coop', difficulty: 'NORMAL', seed: 1, data: DATA, scheduler: new VirtualScheduler(), send() {}, broadcast() {}, onEnd() {}, ...wire };
  const m = new Match(opts);
  assert.equal(m.playerCapacity, 8);
  m.dispose();
});

test('without experimental the payload keeps its upstream key set, and a 5th seat is refused', () => {
  // 普通房（无 experimental）：worker payload 与上游一致，不多出键
  const plain = wireOptions({ roomCode: 'ABCD', mode: 'solo' });
  assert.deepEqual(plain, { roomCode: 'ABCD', mode: 'solo' });

  // 不带 experimental 的 5 座此刻会抛 —— 这正是本次修复要避免的结果
  assert.throws(
    () => new Match({
      mode: 'coop', difficulty: 'NORMAL', seed: 1, data: DATA, scheduler: new VirtualScheduler(),
      send() {}, broadcast() {}, onEnd() {}, seats: seats(5),
    }),
    /seats exceed room capacity/,
  );
});
