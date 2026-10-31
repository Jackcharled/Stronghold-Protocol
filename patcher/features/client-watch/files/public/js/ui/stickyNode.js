// public/js/ui/stickyNode.js — 「我正开着一局，请别再把我改派到别的节点」。
//
// 为什么需要它（2026-10-31）
// ------------------------------------------------------------------
// nginx 会用 `sp_route` cookie 把浏览器钉在某台节点上，这个 cookie 有效期 30 天。
// 一个节点重启到新代码后，它就不再接新玩家（`X-SP-Accepts-New: 0`）；
// 但**手上还留着 30 天老 cookie 的人**会被一直钉在那台上 —— 哪怕他根本不在对局里。
//   实测：node-6 在 10-31 凌晨重启前，5 个新房全是这样进来的，不是新分配。
//
// 于是 nginx 收紧成：cookie 指向旧代码节点时，只有「正开着对局」的人才准粘住。
// 判据就是这个模块写的 `sp_sticky` cookie：
//   * 进了对局（selectRoute === 'game'）→ 写入 `sp_sticky=<当前节点号>`
//   * 离开对局 / 回大厅          → 立刻删掉
//   * 页面刚打开就发现自己不在对局 → 也删掉（清掉上一个会话的残留）
//
// 没有这个 cookie 的人，nginx 会把首页请求改派到随机的新代码节点 —— 这正是我们要的。
// 有它的人刷新/重连会回到原来那台，对局不会丢。
//
// ★ 这个 cookie 只能由前端写：nginx 是「看 cookie 做决定」的一端，它不能自己判断
//   「这个人是不是在打对局」。所以这里的写入时机必须准，宁可多删不可多留。

const COOKIE = 'sp_sticky';
const MAX_AGE = 7 * 24 * 3600; // 秒。比一次对局长得多，但远短于 sp_route 的 30 天。

/** 当前页面落在这台节点上。
 *
 * 怎么知道是哪台：nginx 给每个 HTML 文档响应写 `sp_node` cookie
 * （`add_header Set-Cookie "sp_node=$sp_node; Path=/; Max-Age=2592000"`），
 * 它就是「这次请求实际被分到的那台」。走域名时浏览器地址里没有端口，
 * 所以不能靠 location.port 猜 —— 读这个 cookie 才是准的。
 */
function currentNode() {
  try {
    const m = document.cookie.match(/(?:^|;\s*)sp_node=(\d{1,2})/);
    if (m) {
      const v = Number(m[1]);
      if (Number.isInteger(v) && v >= 1 && v <= 30) return v;
    }
  } catch { /* ignore */ }
  return 0;
}

function readSticky() {
  try {
    const m = document.cookie.match(/(?:^|;\s*)sp_sticky=(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

function writeSticky(node) {
  try {
    document.cookie = `${COOKIE}=${node}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`;
  } catch { /* ignore */ }
}

function clearSticky() {
  try {
    document.cookie = `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch { /* ignore */ }
}

/**
 * 订阅 store，按「是否在打对局」维护 sp_sticky。
 *
 * @param {{ subscribe: (fn: Function) => Function, get: () => any }} store
 * @param {{ selectRoute: (s: any) => string }} router
 * @returns {() => void} 取消订阅
 */
export function startStickyNode(store, router) {
  let lastInMatch = null;

  const sync = (s) => {
    let inMatch = false;
    try { inMatch = router.selectRoute(s) === 'game'; } catch { inMatch = false; }
    if (inMatch === lastInMatch) return;
    lastInMatch = inMatch;
    if (inMatch) {
      const node = currentNode();
      // 拿不到节点号就别写 —— 写一个错的进去比不写更糟（会把人钉在错误的节点上）。
      if (node) writeSticky(node);
    } else {
      clearSticky();
    }
  };

  // 先按当前状态对齐一次：页面刚打开时如果不在对局，清掉上次的残留。
  sync(store.get());
  return store.subscribe(sync);
}

/** 仅供测试：把 cookie 的读写拆出来，避免测试真的去动 document.cookie。 */
export const __internals = { COOKIE, currentNode, readSticky, writeSticky, clearSticky };
