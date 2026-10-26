#!/usr/bin/env node
// patcher/check-features.mjs — 上游更新后自动检查「本服功能还在不在」。
//
// 为什么需要它：这次会话踩过三次「文件在、CSS 在、但功能其实是死的」——
//   表情弹幕组件和样式都写好了，game.js 却从没 import 它；
//   观战席分母写死常量，服务端算出来的动态值根本没人用；
//   隐身观战只修了广播、漏了单播，单测全绿但真实进程还是坏的。
// 靠肉眼看 diff 发现不了这类问题，所以这里把每个功能的「关键代码痕迹」
// 写成可执行的断言，合并完上游跑一次就知道有没有丢。
//
// 用法：
//   node patcher/check-features.mjs                 检查线上运行目录（默认 <repo>/../node-1）
//   node patcher/check-features.mjs --dir <路径>     检查指定目录（刚合并出来的源码）
//   node patcher/check-features.mjs --json          输出 JSON（给 CI 用）
//
// 退出码：0 全部通过；1 有功能缺失。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.SP_REPO || path.dirname(HERE);
const RUNTIME = process.env.SP_RUNTIME
  || (path.basename(REPO) === 'repo-sync' ? path.dirname(REPO) : REPO);

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const TARGET = argOf('--dir') || path.join(RUNTIME, 'node-1');
const AS_JSON = argv.includes('--json');

/**
 * 每个功能一条：files 里任一文件缺失 → fail；rules 里每条都必须命中。
 * rule = [文件, 正则, 说明]
 */
const CHECKS = [
  {
    id: 'client-emote-danmaku',
    name: '5–20 人房表情弹幕',
    rules: [
      ['public/js/ui/danmaku.js', /export function Danmaku/, 'Danmaku 组件'],
      ['public/js/ui/teamLayout.js', /export function teamEmoteMode/, 'teamEmoteMode 判定'],
      ['public/js/screens/game.js', /import \{ Danmaku \}/, 'game.js 导入 Danmaku'],
      ['public/js/screens/game.js', /emoteMode === 'danmaku'[\s\S]{0,80}Danmaku/, '★ game.js 真的渲染了 Danmaku'],
      ['public/js/ui/teamPanel.js', /const rowBubbles = teamEmoteMode\(/, '★ 弹幕模式下不再挂行内气泡'],
      ['public/css/screens/game.css', /\.gm__hud > \.danmaku/, '弹幕样式'],
    ],
  },
  {
    id: 'client-room-spectator',
    name: '观战上限（动态）+ 隐身观战',
    rules: [
      ['public/js/screens/room.js', /\/\$\{facts\.maxSpectators\}/, '★ 观战席分母用动态值'],
      ['server/lobby.js', /spectatorLimit\(\)\s*\{[\s\S]{0,160}Math\.max\(MAX_SPECTATORS/, '服务端动态上限'],
      ['server/lobby.js', /room\.hiddenSpectatorOf\(playerId\)/, '★ sendToPlayer 认隐身观战者'],
      ['server/lobby.js', /\.\.\.\(Array\.isArray\(room\.hiddenSpectators\)/, '★ 广播覆盖隐身观战者'],
      // 隐身观战者不在 seats 也不在 spectators 里：roomOf() 漏了它的话，roomCode 会被清空，
      // g.watch 直接回 NOT_IN_ROOM —— 表现就是「观战画面永远停在 P1，点谁都不换」。
      ['server/lobby.js', /if \(room && !seat && room\.hiddenSpectatorOf\(session\.playerId\)\) return room;/, '★ roomOf 认隐身观战者（否则无法切换观战目标）'],
      ['server/lobby.js', /msg\.t !== 'g\.watch'[\s\S]{0,200}room\.watcherOf\(session\.playerId\)/, '★ 隐身观战者只能 watch，不能替玩家操作'],
      ['server/match/match/watch.js', /addSpectator\(playerId, hidden = false\)/, 'Match.addSpectator 支持 hidden'],
    ],
  },
  {
    id: 'client-guest-create',
    name: '游客不能建房/开始独立模拟',
    rules: [
      ['server/lobby.js', /游客不能创建同盟模拟房间/, '★ 游客建房拦截'],
      ['server/lobby.js', /游客不能开始独立模拟/, '★ 游客独立模拟拦截'],
      ['server/lobby.js', /guest: session\.guest === true \|\| !session\.accountId/, '座位带 guest 标记'],
      ['server/lobby.js', /migrateHost[\s\S]{0,600}guest !== true/, '★ 房主继承跳过游客'],
    ],
  },
  {
    id: 'server-player-capacity',
    name: '5–20 人房容量',
    rules: [
      ['shared/playerCapacity.js', /PLAYER_CAPACITIES/, '容量常量'],
      ['server/lobby.js', /experimental: \{ \.\.\.room\.experimental \}/, '★ startMatch 传实验选项'],
      ['shared/constants.js', /MAX_SEATS/, 'MAX_SEATS'],
    ],
  },
  {
    id: 'client-asset-cache',
    name: '素材缓存 / Cache Storage 记录',
    rules: [
      ['public/js/assetCache.js', /sp-imported-assets-v2/, 'Cache Storage 名'],
      ['public/js/assetDownload.js', /cache\.match\(url\)/, '★ 用 Cache Storage 判断已下载'],
      ['public/js/assetDownload.js', /sp\.assetDownload\.done/, '★ 已完成状态持久化'],
      ['public/js/assetDownload.js', /const body = await request\(url\)/, '★ 写缓存不重复请求'],
      ['public/sw.js', /sp-imported-assets-v2/, 'Service Worker 同名缓存'],
    ],
  },
  {
    id: 'client-room-timer',
    name: '对局结束重置 15 分钟解散计时',
    rules: [
      ['server/lobby.js', /room\.lastMatchEndAt = this\.now\(\)/, '★ 对局结束重置计时基准'],
      ['server/lobby.js', /Math\.max\(Number\(this\.createdAt\) \|\| 0, Number\(this\.lastMatchEndAt\)/, 'room.state 用较晚者'],
    ],
  },
  {
    id: 'server-room-round',
    name: '后台显示对局回合',
    rules: [
      ['server/lobby.js', /room\.liveRound = r/, '★ 回填回合数'],
      ['server/lobby.js', /room\.livePhase = msg\.phase/, '回填阶段'],
    ],
  },
  {
    id: 'server-stuck-match-reap',
    name: '卡死对局房间回收（不影响正常对局）',
    rules: [
      // 以前 sweepOldRooms 见到 room.match 就 continue，房主断线后对局永远卡着、房间永不过期
      ['server/lobby.js', /if \(room\.match\) \{\s*\n\s*if \(forever\) continue;/, '★ 对局中的房间也要过一遍过期判定'],
      ['server/lobby.js', /room\.activeHumans\(\)\.some\(\(s\) => s && s\.connected\)\) continue;/, '★ 有真人在线就绝不回收'],
      ['server/lobby.js', /room\.lastHumanLeftAt = this\.now\(\)/, '★ 记录最后一人断线时刻'],
      ['server/lobby.js', /if \(room\.lastHumanLeftAt\) room\.lastHumanLeftAt = 0;/, '★ 有人回来就作废回收计时'],
      // 管理员房：人在才永久保留，人走了也要回收
      ['server/lobby.js', /return !!\(session && session\.admin === true && session\.connected === true\);/, '★ noExpire 只在管理员在线时生效'],
      // 光有 adminOwnerOnline() 不够，必须真的被 sweepOldRooms 用来决定 forever
      ['server/lobby.js', /const forever = room\.noExpire === true && this\.adminOwnerOnline\(room\);/, '★ 过期判定必须调用 adminOwnerOnline（不能只看 noExpire 标志）'],
      ['server/lobby.js', /room\.adminLeftAt = this\.now\(\)/, '★ 记录管理员离线时刻'],
      ['server/lobby.js', /Number\(room\.adminLeftAt\)/, '★ 管理员房从离线时刻起计时'],
    ],
  },
  {
    id: 'client-mobile-quality',
    name: '手机「画面质量」真正生效',
    rules: [
      // 以前 `lean ? 1 : 2`：触屏一律夹到 DPR 1，手机上高画质等于没设，画面糊
      ['public/js/render/app.js', /const TOUCH_DPR_CAP = \{/, '★ 触屏像素上限按画质分档'],
      ['public/js/render/app.js', /lean \? \(TOUCH_DPR_CAP\[settings\.quality\] \|\| 1\) : 2/, '★ dpr() 用分档表'],
      ['public/js/render/app.js', /lean \? \(TOUCH_BOARD_DPR_CAP\[settings\.quality\] \|\| 0\.85\) : 2/, '★ boardDpr() 用分档表'],
      ['public/js/render/app.js', /TOUCH_DPR_CAP = \{ high: 2, medium: 1\.5, low: 1 \}/, '★ 手机高画质 = 2x'],
    ],
  },
  {
    id: 'client-enemy-local-model',
    name: '只有本地素材的敌人模型能加载',
    rules: [
      // assets.json 声明 spineLocal，但 local-assets.json 没有对应 group → 解析成 null → 画灰块。
      // 这 6 个敌人没有 web 模型，全靠本地素材，清单漏登记就必然缺失。
      ['data/local-assets.json', /"spine\/enemy\/enemy_1201_sfzhi"/, '★ enemy_1201_sfzhi 的 group'],
      ['data/local-assets.json', /"spine\/enemy\/enemy_1249_lysdb"/, '★ enemy_1249_lysdb 的 group'],
      ['data/local-assets.json', /"spine\/enemy\/enemy_1254_lypa"/, '★ enemy_1254_lypa 的 group'],
      ['data/local-assets.json', /"spine\/enemy\/enemy_1275_dwlock"/, '★ enemy_1275_dwlock 的 group'],
      ['data/local-assets.json', /"spine\/enemy\/enemy_1373_ltnhor_2"/, '★ enemy_1373_ltnhor_2 的 group'],
      ['data/local-assets.json', /"spine\/enemy\/enemy_1376_ltndru"/, '★ enemy_1376_ltndru 的 group'],
    ],
  },
  {
    id: 'client-op-model-retry',
    name: '干员模型加载失败不会永久放弃',
    rules: [
      // 旧实现：SPINE_RETRY_MS 用完（约 40 秒）就彻底放弃，之后只能靠切标签页触发 retryAssets，
      // 玩家一直盯着屏幕就永远只有菱形头像
      ['public/js/render/units.js', /export const SPINE_RETRY_MAX_MS = \d+/, '★ 长期退避上限常量'],
      ['public/js/render/units.js', /this\._retryAt = nowMs\(\) \+ wait;/, '★ 失败后无条件安排下次重试'],
      ['public/js/render/units.js', /tries < SPINE_RETRY_MS\.length/, '★ 先快速重试'],
      ['public/js/render/units.js', /Math\.min\(SPINE_RETRY_MAX_MS/, '★ 长期退避封顶（不放弃）'],
    ],
  },
  {
    id: 'client-spine-cache-bust',
    name: '模型 404 被缓存后能自愈',
    rules: [
      // CDN 对 404 也发 immutable + 30 天缓存 → 一次失败 = 30 天拿不到模型
      ['public/js/assets.js', /const spineBust = \(entry, n\) =>/, '★ cache-buster 生成'],
      ['public/js/assets.js', /spineBust\(entry, \+\+spineBustSeq\)/, '★ 重试路径调用它'],
      ['public/js/assets.js', /if \(!\(o && o\.fresh\)\) return \(opts\.loadSpine \|\| loadSpineData\)\(entry\);/, '★ 首次加载不加 bust（仍走 CDN 缓存）'],
    ],
  },
  {
    id: 'client-module-exports',
    name: '模块导入完整性（导入的名字必须真的导出）',
    rules: [
      // 2026-10-26 事故：bandDraft.js 导入 draftMyTurn，但 gameLogic.js 漏了 re-export，
      // 浏览器抛 SyntaxError → 整个模块图崩 → 全站「游戏脚本加载失败」。node --check 抓不到这类错误。
      ['public/js/ui/gameLogic.js', /export \{[^}]*draftMyTurn[^}]*\} from '\.\/gameLogic\/draft\.js'/, '★ draftMyTurn 必须被 re-export'],
      ['public/js/screens/bandDraft.js', /import \{[^}]*draftMyTurn[^}]*\} from '\.\.\/ui\/gameLogic\.js'/, 'bandDraft 的导入'],
    ],
  },
  {
    id: 'admin-room-version',
    name: '后台/控制台显示房间版本',
    rules: [
      // 房间文档必须存 version，否则 matchmaker/后台都读不到（全部当成默认版本）
      ['server/persist/lobbyState.js', /version: room\.version,/, '★ 房间文档存 version'],
      ['server/persist/lobbyState.js', /typeof r\.version === 'string'/, '★ 恢复房间时带回 version'],
      ['matchmaker/server.js', /version: typeof doc\.version === 'string' && doc\.version \? doc\.version : 'act2autochess'/, '★ roomInfo 输出 version'],
      // 后台控制台（节点控制台 dashboard）
      ['dashboard/public/index.html', /<th>版本<\/th>/, '★ dashboard 房间表头有版本列'],
      ['dashboard/public/app.js', /class="room-ver/, '★ dashboard 渲染版本单元格'],
      ['dashboard/public/index.html', /#rooms-bar \.room-ver/, 'dashboard 版本样式'],
      // 管理后台（matchmaker admin.html，不进 git，仅本地校验）
      ['matchmaker/public/admin.html', /<th>版本<\/th>/, '★ 管理后台房间表头有版本列'],
      ['matchmaker/public/admin.html', /class="room-ver/, '★ 管理后台渲染版本单元格'],
      ['matchmaker/public/admin.html', /#roomBody \.room-ver/, '管理后台版本样式'],
      // 加列时必须同步调整列宽索引，否则「玩家」列被挤成竖排（2026-10-26 实际发生过）
      ['matchmaker/public/admin.html', /#roomsCard th:nth-child\(8\)\{width:19%\}/, '★ 玩家列（第8列）宽度足够'],
      ['matchmaker/public/admin.html', /#roomsCard th:nth-child\(13\)\{width:\d+%\}/, '13 列的宽度都有定义'],
    ],
  },
  {
    id: 'server-one-room-per-account',
    name: '一个账号只能在一个房间 + 遗留座位自愈',
    rules: [
      ['server/lobby.js', /accountRoomConflict\(session\)/, '冲突检查'],
      ['server/lobby.js', /dropStaleAccountSeats/, '★ 清理刷新后的遗留座位'],
      ['server/lobby.js', /conflict\.stale/, '★ 遗留座位不再拦建房'],
    ],
  },
  {
    id: 'server-room-limit',
    name: '同网络建房上限可配置',
    rules: [
      ['server/lobby.js', /maxRoomsPerAddr/, '同网络建房上限'],
      ['../ecosystem.config.cjs', /SP_MAX_ROOMS_PER_ADDR/, 'PM2 环境变量'],
    ],
  },
  {
    id: 'matching-party',
    name: '匹配队友 / 组队',
    rules: [
      ['server/lobby.js', /matchmaking/, '房间匹配字段'],
      ['server/lobby.js', /开始匹配队友/, '匹配日志'],
    ],
  },
  {
    id: 'client-watch',
    name: '隐藏观战 / 退出清理',
    rules: [
      ['public/js/main.js', /m\.emote/, '表情事件订阅'],
      ['public/js/ui/matchChrome.js', /sp\.matchExitAtShared/, '★ 退出对局标记共享'],
    ],
  },
  {
    id: 'client-announcement',
    name: '公告 / 官方Q群入口',
    rules: [
      ['../matchmaker/public/client.js', /mm-qq/, 'Q群按钮'],
      ['../matchmaker/public/client.js', /mm-notice-btn|announcement/, '公告按钮'],
    ],
  },
];

// ---- 执行 ------------------------------------------------------------------------
function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

if (!fs.existsSync(TARGET)) {
  console.error(`目标目录不存在：${TARGET}`);
  process.exit(2);
}

// 目录可能只是「合并输出」，只含本轮合并涉及的文件，并不是完整部署树。
// 这时对不在目录里的文件不该报缺失 —— 它们由完整源码树提供，本就不在合并范围内。
// 判定：目录里连 server/ 和 public/ 都凑不齐多数文件，就当作部分目录。
function looksPartial(dir) {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 3 || n > 400) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else if (++n > 400) return;
    }
  };
  walk(dir, 0);
  return n < 400;   // 完整 node-1 有几千个文件；合并输出只有一百多个
}
const PARTIAL = looksPartial(TARGET);

const results = [];
const absent = [];
for (const feature of CHECKS) {
  const misses = [];
  for (const [rel, re, label] of feature.rules) {
    // 部署树里 server/ public/ 在 node-N/ 下，而 matchmaker/ dashboard/ 等是同级目录。
    // TARGET 是 node-N（或合并输出），所以先按 TARGET 找，找不到再回 RUNTIME 根目录找。
    let src = readSafe(path.resolve(TARGET, rel));
    if (src == null) src = readSafe(path.resolve(RUNTIME, rel));
    if (src == null) {
      if (PARTIAL) { absent.push({ feature: feature.id, rel, label }); continue; }
      misses.push({ rel, label, why: '文件不存在' });
      continue;
    }
    if (!re.test(src)) misses.push({ rel, label, why: '关键代码未命中' });
  }
  results.push({ id: feature.id, name: feature.name, ok: misses.length === 0, misses });
}

const failed = results.filter((r) => !r.ok);

if (AS_JSON) {
  console.log(JSON.stringify({ target: TARGET, partial: PARTIAL, ok: failed.length === 0, results, absent }, null, 2));
} else {
  console.log(`检查目录：${TARGET}`);
  if (PARTIAL) console.log('（这是一个部分目录，如合并输出；不在其中的文件按「由完整源码树提供」处理）');
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}  (${r.id})`);
    for (const m of r.misses) {
      console.log(`          ✗ ${m.label} — ${m.rel}：${m.why}`);
    }
  }
  if (PARTIAL && absent.length) {
    console.log(`\n  ${absent.length} 条规则所在文件不在本目录（合并范围外），如需确认请对完整目录再跑一次。`);
  }
  console.log('');
  if (failed.length) {
    console.log(`${failed.length} 个功能缺失：`);
    for (const r of failed) console.log(`  - ${r.name} (${r.id})`);
    console.log('\n上游合并后请逐个把上面的代码补回去。');
  } else {
    console.log(`全部 ${results.length} 个功能的关键代码都在${PARTIAL ? '（合并范围内）' : ''}。`);
  }
}

process.exit(failed.length ? 1 : 0);
