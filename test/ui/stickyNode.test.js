// test/ui/stickyNode.test.js — public/js/ui/stickyNode.js: the `sp_sticky` cookie that tells nginx
// "this browser is in a match right now, keep it on the node that hosts it".
//
// The rule it feeds (nginx/conf/nginx.conf, location /): a `sp_route` cookie pointing at a node that still
// runs old code is honoured ONLY for a browser that also carries `sp_sticky`. Everyone else — a player who
// closed the game days ago but kept the 30-day `sp_route` cookie — is re-dispatched to a current node.
// So the contract here is: write it exactly while a match is on screen, and never leave it behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStickyNode } from '../../public/js/ui/stickyNode.js';

/** A fake store with the same subscribe contract as public/js/store.js. */
function fakeStore(initial) {
  let state = initial;
  const fns = new Set();
  return {
    get: () => state,
    set(next) { state = next; for (const f of fns) f(state); },
    subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
    size: () => fns.size,
  };
}

/** A fake document.cookie: a real cookie jar, so a test can read back what a write produced. */
function fakeCookie(initial = {}) {
  const jar = { ...initial };
  return {
    jar,
    get() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); },
    set(v) {
      const [pair] = String(v).split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (/Max-Age=0\b/.test(String(v))) delete jar[name];
      else jar[name] = value;
    },
  };
}

/** Install the fake document for the duration of `fn`. */
function withDocument(cookie, fn) {
  const g = globalThis;
  const prev = g.document;
  g.document = { get cookie() { return cookie.get(); }, set cookie(v) { cookie.set(v); } };
  try { return fn(); } finally { if (prev === undefined) delete g.document; else g.document = prev; }
}

/**
 * Fake timers, so a test never arms a real setInterval (which would keep the
 * node:test process alive forever). `tick()` fires the refresh callback by hand.
 */
function fakeTimers() {
  const t = { fn: null, armed: 0, cleared: 0 };
  return {
    timers: {
      setInterval: (fn) => { t.fn = fn; t.armed += 1; return t.armed; },
      clearInterval: () => { t.fn = null; t.cleared += 1; },
      refreshMs: 1000,
    },
    tick: () => { if (t.fn) t.fn(); },
    get armed() { return t.fn !== null; },
    state: t,
  };
}
/** A router whose route the test drives directly. */
const routerOf = () => {
  let route = 'title';
  return { set: (r) => { route = r; }, selectRoute: () => route };
};

test('entering a match writes sp_sticky with the node from the sp_node cookie', () => {
  const cookie = fakeCookie({ sp_node: '7', sp_route: '7' });
  withDocument(cookie, () => {
    const store = fakeStore({});
    const router = routerOf();
    startStickyNode(store, router, fakeTimers().timers);
    assert.equal(cookie.jar.sp_sticky, undefined, 'title screen: nothing written');
    router.set('game');
    store.set({});
    assert.equal(cookie.jar.sp_sticky, '7');
  });
});

test('leaving the match clears sp_sticky immediately', () => {
  const cookie = fakeCookie({ sp_node: '6', sp_route: '6', sp_sticky: '6' });
  withDocument(cookie, () => {
    const store = fakeStore({});
    const router = routerOf();
    startStickyNode(store, router, fakeTimers().timers);
    router.set('game');
    store.set({});
    assert.equal(cookie.jar.sp_sticky, '6');
    router.set('lobby');
    store.set({});
    assert.equal(cookie.jar.sp_sticky, undefined, 'lobby must not keep the pin');
  });
});

test('a stale sp_sticky from the previous session is cleared on load', () => {
  // The page opens straight into the lobby (or the title): the player is NOT in a match,
  // so a leftover cookie from yesterday must go — that is the whole point of the rule.
  const cookie = fakeCookie({ sp_node: '22', sp_route: '22', sp_sticky: '6' });
  withDocument(cookie, () => {
    const store = fakeStore({});
    const router = routerOf();
    startStickyNode(store, router, fakeTimers().timers);
    assert.equal(cookie.jar.sp_sticky, undefined);
  });
});

test('no sp_node cookie (nginx never answered) → no write, rather than a wrong pin', () => {
  const cookie = fakeCookie({});
  withDocument(cookie, () => {
    const store = fakeStore({});
    const router = routerOf();
    startStickyNode(store, router, fakeTimers().timers);
    router.set('game');
    store.set({});
    assert.equal(cookie.jar.sp_sticky, undefined, 'guessing a node is worse than not pinning');
  });
});

test('an out-of-range sp_node is rejected', () => {
  for (const bad of ['0', '31', '99', '']) {
    const cookie = fakeCookie({ sp_node: bad });
    withDocument(cookie, () => {
      const store = fakeStore({});
      const router = routerOf();
      startStickyNode(store, router, fakeTimers().timers);
      router.set('game');
      store.set({});
      assert.equal(cookie.jar.sp_sticky, undefined, `sp_node=${bad} must not be pinned`);
    });
  }
});

test('repeated store notifications inside one match do not rewrite the cookie', () => {
  const jar = { sp_node: '12' };
  let writes = 0;
  const g = globalThis;
  const prev = g.document;
  g.document = {
    get cookie() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(v) { writes += 1; },
  };
  try {
    const store = fakeStore({});
    const router = routerOf();
    startStickyNode(store, router, fakeTimers().timers);
    router.set('game');
    store.set({});
    const afterFirst = writes;
    store.set({});
    store.set({});
    store.set({});
    assert.equal(writes, afterFirst, 'an unchanged in-match state must not touch document.cookie');
  } finally {
    if (prev === undefined) delete g.document; else g.document = prev;
  }
});

test('the returned disposer unsubscribes', () => {
  const cookie = fakeCookie({ sp_node: '9' });
  withDocument(cookie, () => {
    const store = fakeStore({});
    const router = routerOf();
    const stop = startStickyNode(store, router, fakeTimers().timers);
    assert.equal(store.size(), 1);
    stop();
    assert.equal(store.size(), 0);
  });
});

test('in a match the cookie is refreshed periodically (survives a long match)', () => {
  const jar = { sp_node: '8' };
  let writes = 0;
  const g = globalThis;
  const prev = g.document;
  g.document = {
    get cookie() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(v) { writes += 1; },
  };
  // A fake interval we drive by hand.
  let tick = null;
  const setI = (fn) => { tick = fn; return 1; };
  const clearI = () => { tick = null; };
  try {
    const store = fakeStore({});
    const router = routerOf();
    startStickyNode(store, router, { setInterval: setI, clearInterval: clearI, refreshMs: 1000 });
    router.set('game');
    store.set({});
    const afterEnter = writes;
    assert.ok(tick, 'a refresh timer must be armed in a match');
    tick(); tick();
    assert.equal(writes, afterEnter + 2, 'each tick rewrites the cookie');
    // Leaving the match must stop the timer, so no writes happen afterwards.
    router.set('lobby');
    store.set({});
    assert.equal(tick, null, 'the timer must be cleared when the match ends');
    const afterLeave = writes;
    assert.equal(writes, afterLeave);
  } finally {
    if (prev === undefined) delete g.document; else g.document = prev;
  }
});

test('the disposer also clears the refresh timer', () => {
  const jar = { sp_node: '9' };
  const g = globalThis;
  const prev = g.document;
  g.document = { get cookie() { return `sp_node=${jar.sp_node}`; }, set cookie(_v) { /* ignore */ } };
  let tick = null;
  try {
    const store = fakeStore({});
    const router = routerOf();
    const stop = startStickyNode(store, router, { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = null; } });
    router.set('game');
    store.set({});
    assert.ok(tick);
    stop();
    assert.equal(tick, null, 'disposing must stop the timer too');
    assert.equal(store.size(), 0);
  } finally {
    if (prev === undefined) delete g.document; else g.document = prev;
  }
});
test('cookie attribute sanity: 7 days, Path=/, SameSite=Lax', () => {  const cookie = fakeCookie({ sp_node: '4' });
  let raw = '';
  const g = globalThis;
  const prev = g.document;
  g.document = { get cookie() { return cookie.get(); }, set cookie(v) { raw = String(v); cookie.set(v); } };
  try {
    const store = fakeStore({});
    const router = routerOf();
    startStickyNode(store, router, fakeTimers().timers);
    router.set('game');
    store.set({});
  } finally {
    if (prev === undefined) delete g.document; else g.document = prev;
  }
  assert.match(raw, /^sp_sticky=4;/);
  assert.match(raw, /Path=\//);
  assert.match(raw, /SameSite=Lax/);
  const m = raw.match(/Max-Age=(\d+)/);
  assert.ok(m, 'Max-Age present');
  assert.equal(Number(m[1]), 7 * 24 * 3600);
});
