// public/js/ui/adminGate.js — 「现在能不能打开游戏内管理员工具」的唯一判据。
//
// 维护者的规则（2026-10-31）：
//   **只有在自己参与的对局中才能打开管理员工具；观战和隐身观战都不能。**
//
// 为什么必须挡观战：隐身观战（?adminWatch=1）本身就是「管理员旁看别人的对局」，
// 那时面板改的是别人的场子，出事也说不清是谁动的；普通观战同理，而且观战者
// 本来就不是这局的玩家，没有理由去改它的数值。
//
// 这段逻辑原来散在 mm/client.js（注入脚本，拿不到 React 状态）和 ui/hud.js（监听事件）两处，
// 两边各写一遍容易走样，所以抽到这里，两处都调它。
//
// 注意：**这不是安全边界**。真正的防线在服务端（Match.applyTestCommand 会再查一次 ps.admin），
// 这里只负责「别让不该出现的面板出现」—— 用户体验层面的门。

/**
 * 现在能不能打开管理员工具。
 *
 * @param {any} s store 状态（`store.get()` 的返回值）
 * @returns {boolean}
 */
export function canOpenAdminTools(s) {
  // ① 身份门：必须是管理员账号（owner/admin）。普通玩家 adminId 也是 false。
  if (!s || s.adminId !== true) return false;

  // ② 必须在「有对局」的状态：大厅、房间等待室里没有对局可改。
  if (!s.match || !s.match.public) return false;

  // ③ 必须能确认「我是谁、我在哪个房间」。
  const room = s.room;
  const myId = s.me && s.me.playerId;
  if (!room || myId == null) return false;

  // ④ 观战者一律不能开 —— 普通观战和隐身观战都会出现在 room.spectators 里。
  if ((room.spectators || []).some((x) => x && x.playerId === myId)) return false;

  // ⑤ 必须自己坐在座位上。没席位却在对局里，就是「在看别人打」（老版本的隐身观战）。
  return (room.seats || []).some((x) => x && x.playerId === myId);
}
