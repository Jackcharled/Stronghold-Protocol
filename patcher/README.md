# 补丁包（patcher）

这里保存**本服相对上游的全部改动**，以及一键还原/重打脚本。上游升级时靠它把功能原样装回去。

## ⚠ 2026-10-26 补齐说明

此前这份 README 写着「涉及的游戏文件只有两个」——那是补丁体系刚建立时的状态。
之后功能不断扩张，补丁没有跟着更新，一度有 **138 个功能代码文件**（5–20 人大厅、
并发草稿、悬赏计时、跳过按钮、联防分段、重连窗口、恢复对局、代号规则等）**不在任何补丁里**，
上游升级时会全部丢失。

现已全部补齐，当前覆盖 **312 个文件 / 200 个运行时改动，未覆盖 0**。

## 怎么确认没有遗漏

```bash
node patcher/check-coverage.mjs          # 有遗漏则退出码 1
node patcher/check-coverage.mjs --list   # 列出全部文件
```

它把「当前代码相对 upstream/master 的所有改动」与「patcher/features 的覆盖集合」逐文件对比。
**每次加完功能请跑一次**；上游升级前更要跑。

不纳入补丁管理的路径（脚本里已内置）：`public/vendor/`（第三方库，上游整包替换）、
`test/`、`tools/`、`schemas/`、`packs/`、`nginx/`（部署配置，见 `deploy/nginx.conf`）、
`package*.json`、图片资源、以及上游 `.gitignore` 明令禁止提交的 `matchmaker/public/admin.html`。

## 目录

```
patcher\
├─ features\                每个功能一个目录
│  └─ <feature>\
│     ├─ base\<path>        上游原版（来自 upstream/master）
│     └─ files\<path>       我们的版本
├─ features.json            功能清单与说明
├─ orig\                    早期锚点补丁的官方原版
├─ apply.mjs                锚点补丁（幂等插入）
├─ restore.mjs              还原为官方原版
└─ check-coverage.mjs       补丁完整性检查
```

### 功能分组（features/）

| feature | 内容 |
|---|---|
| `game-core-match` | 对局核心：5–20 人大厅、并发草稿、悬赏/盟约、跳过、联防分段、视图下发 |
| `game-core-server` | 服务端本体：连接/会话、重连窗口、持久化、HTTP 路由、模拟数据 |
| `game-core-shared` | 前后端共享常量与规则 |
| `game-core-client-core` | 客户端核心：启动、连接、资源、音频、状态存储 |
| `game-core-client-ui` | 客户端 UI 组件 |
| `game-core-client-screens` | 客户端界面 |
| `game-core-client-render` | 客户端渲染 |
| `game-core-client-style` | 客户端样式 |
| `game-core-data` | 数据与开关（房间 TTL、建房限制） |
| `server-idle-guard` | 挂机踢人、同 IP 建房与 AI 上限 |
| `server-snapshot-checkpoint` | 房间/对局快照与 Redis 检查点 |
| `server-player-capacity` | 5–20 人容量与实验选项 |
| `matching-party` | 组队匹配、跨节点转房 |
| `account-and-dashboard` | 账号登录 / 管理后台 |
| `client-*` 系列 | 公告、观战、游客建房、表情弹幕、资源缓存、商店布局、皮肤导入 |
| `deployment` | nginx、PM2、watchdog |

## 本服新增功能登记表（改代码后请对照更新）

> **这是防止「下次又忘记」的核心表。** 每加一个本服独有功能，就在下面加一行，
> 写清它动到的文件与所属补丁 —— 上游升级后按这张表逐项验收，缺哪个补哪个。
>
> 维护规则：**改了表里任何一行的文件，同一提交里把这张表对应的说明也更新掉。**
> 新增功能漏登记时，`check-coverage.mjs` 只能保证「文件进了补丁」，
> 但**不能**保证「下次升级时有人记得验收它」—— 这一步只能靠这张表。

### 玩法与对局

| 功能 | 涉及文件 | 所属补丁 | 生效方式 |
|---|---|---|---|
| 5–20 人同盟（容量实验） | `server/match/Match.js`、`server/match/match/phases.js`、`shared/playerCapacity.js`、`shared/experimental.js`、`public/js/screens/room.js`<br>**结算显示（2026-10-27）**：`public/js/ui/stats.js`（`MAX_PLAYERS` 取 `MAX_PLAYER_CAPACITY`，原本写死 6 → 记录被截断）、`public/js/screens/settle.js`（`staggerOf`：5–20 张同盟卡片的入场步长，原本 `Math.min(i,7)` 让第 8 张之后同时出现）、`public/css/screens/settle.css`（`.tcard` 动画改用 `var(--step)`） | `server-player-capacity` / `game-core-client-ui` / `game-core-client-style` | 刷新页面 + 重启节点 |
| 并发草稿（仅 allowRepeat 时） | `server/match/Match.js:concurrentDraft()`、`server/match/match/phases.js`<br>**提示文案（2026-10-30）**：`public/js/screens/bandDraft.js:draftTip()` 按 `concurrent` 分支——并发草稿里**没有跳过**（`phases.js:298` 直接拒），超时也**不固定给华法琳**（`taken` 置空后 `autoPickBand` 优先当前高亮），旧提示两件事都写，属于说不得的承诺 | `game-core-match` / `game-core-client-screens` / `game-core-client-ui` | 刷新页面（`bandDraft.js` + i18n） |
| **容量实验跨 worker 转发**（5 人以上房在内容插件 host 下开不了局） | `server/match/host/proxy.js:wireOptions()` —— 白名单里有 `seats` 却漏了 `experimental`，worker 侧 `playerCapacity` 丢失回落到 4 座，第 5 个座位抛 `RangeError: seats exceed room capacity`（生产 2026-10-26～30 累计 481 次） | `server-player-capacity` | **重启节点** |
| 悬赏决策公共计时 | `server/match/match/spDraft.js:_concurrentSpStep()` | `game-core-match` | 重启节点 |
| 跳过按钮（仅非 allowRepeat） | `public/js/match/matchChrome.js:StepHeader`、`server/match/match/phases.js` | `game-core-match` | 刷新页面 + 重启节点 |
| **鸭爵策略可叠加**（实验开关） | `server/sim/content/bands/meta.js:duckGlobal`、`server/match/Match.js`、`server/match/gamedata.js`、`server/match/snapshot.js`、`shared/experimental.js`、`public/js/screens/room.js` | `game-core-server` / `server-snapshot-checkpoint` / `server-player-capacity` | **重启节点** |
| **叠加时「补抽」**（撞到已选敌人时改抽别的目标，而不是跳过；20 人大波次覆盖率 13.6→19.5 个） | `server/sim/content/bands/meta.js:duckPicks`（`exclude` 参数）+ `duckGlobal`（`taken` 传入） | `game-core-server` | **重启节点** |
| 禁用鸭爵策略（5–20 人） | `server/match/gamedata.js`、`shared/experimental.js`、`public/js/screens/bandDraft.js` | `server-player-capacity` | 刷新页面 + 重启节点 |
| **联防救援（队友复活）**：被淘汰的博士在 15 秒窗口内由合格队友支付 10 点生命救回；每局每人最多被救一次 | `shared/protocol.js`（**`C2S` 的 `g.revive` 白名单**）、`server/match/Match.js:revive/revivalWindowOpen/revivalDonorEligible`、`server/match/match/intents.js`、`server/match/match/common.js`、`public/js/ui/revival.js`、`shared/experimental.js` | `server-player-capacity`（客户端 UI 在 `game-core-client-ui`） | **重启节点** |
| 挂机踢人 / 同 IP 限制 | `server/match/match/intents.js` | `server-idle-guard` | 重启节点 |
| 房间/对局快照与 Redis 检查点 | `server/match/snapshot.js`、`server/persist/*` | `server-snapshot-checkpoint` | 重启节点 |
| **结束对局（保留房间）**：控制台/管理后台单独结束一间房当前这一局，房间、座位、玩家都留着，可立刻重新开局（与「关闭房间」并存） | `server/lobby.js:abortMatch`、`server/http/routes.js:handleAdminRoomAbort`（`POST /admin/room/abort`）、`dashboard/server.js:abortMatch/adminRoomAction`、`dashboard/public/app.js`、`matchmaker/account.cjs`（`POST /api/admin2/rooms/abort`）、`matchmaker/public/admin.html`（**不进仓库**） | `game-core-server` | **重启节点**（`dashboard`/`matchmaker` 重启即生效） |

### 连接、恢复与账号

| 功能 | 涉及文件 | 所属补丁 | 生效方式 |
|---|---|---|---|
| 重连窗口 15 分钟（上游 10） | `server/net.js:NET_DEFAULTS.reconnectWindowMs`、`data/room-ttl.json` | `game-core-server` | 重启节点 |
| 掉线恢复：对局中不判终态 | `matchmaker/public/client.js:joinFlow`（startedCode 分支） | `matching-party` | 刷新页面 |
| 恢复对局（仅大厅显示按钮） | `matchmaker/public/client.js:installResumeButton` | `matching-party` | 刷新页面 |
| 账号恢复失败提示（不再误导） | `public/js/ui/accountObserver.js` | `account-and-dashboard` | **重启节点** |
| 同账号同房间接管座位 | `server/lobby.js:room.join` 的 takeover 分支 | `game-core-server` | 重启节点 |
| **回自己房间时先接管、不清房间**（`room.join` 的冲突判定顺序：同房间 → 接管；别的房间 → `dropStaleAccountSeats`） | `server/lobby.js:room.join` | `game-core-server` | 重启节点 |
| **接管后不再误清房间**（`room.state` 早于 `welcome` 到达时，用 `net.playerIdPending` 跳过身份比对，避免卡「正在进入模拟…」） | `public/js/main.js:onRoomState`、`public/js/net.js`（`_sendHello` / `_onWelcome` / `_onHelloError`） | `account-and-dashboard` | **刷新页面** |
| **恢复对局只能手动点**（去掉全部自动跳转/自动恢复；换设备、刷新、重新打开页面都不再自己跳） | `public/js/ui/accountObserver.js`、`public/js/ui/resumeMatch.js`、`matchmaker/public/client.js`（`installAutoRejoin` / `resumeTick`） | `account-and-dashboard` / `matching-party` | **刷新页面**（client.js 需重启 matchmaker） |
| **被接管的旧标签页回大厅**（不再尝试 `room.spectate` 旁观自己的座位，杜绝「观战席不可用」） | `public/js/ui/accountObserver.js:account.detached` | `account-and-dashboard` | **刷新页面** |
| **「你有进行中的对局」提示 + 高亮恢复入口**（2026-10-30，维护者要求）：<br>① **对局中手动刷新** → 静默自动回到对局，**不弹任何提示**（原有行为，不改）<br>② **多标签页 / 换设备接管** → 被夺走的那台不再只说一句 8 秒 toast：写 `sessionStorage['sp.resumeAvailable']`、派发 `sp-resume-available` 事件，大厅里恢复按钮变 `.verchip--urgent` 高亮并显示 `.resume-banner` 常驻引导条<br>③ **标题页** → 登录框上方显示 `.title-resume` 蓝色引导条（标题页已有 `ResumeMatchButton`，故不再显示大厅那条横幅，避免同一件事说两遍）<br>恢复成功（`resume` / `resumeAccount`）后清除标记 | `public/js/ui/accountObserver.js`（`account.detached`）、`public/js/ui/resumeMatch.js`（`urgent` 状态 + `showBanner` + `clearUrgent`）、`public/js/screens/title.js`（`.title-resume` 引导条）、`public/css/components.css`（`.verchip--urgent` / `.resume-banner`）、`public/css/screens/title.css`（`.title-resume`）、`public/i18n/*.json` | `account-and-dashboard` | **刷新页面** |
| **DOCTOR # 显示真实账号 tag** | `server/lobby.js`（`room.state seats[].tag`）、`public/js/screens/room.js:seatNo()` | `game-core-server` / `server-player-capacity` | **重启节点**（前端回退到哈希） |
| **名片立绘跟随账号** | `matchmaker/account.cjs`（DOMAINS + validatePrefPayload + decodePrefPayload）、`matchmaker/public/account-title.js:PREF_MAP.card`、`public/js/ui/seatArt.js` | `account-and-dashboard` / `matching-party` | 重启 matchmaker |
| 账号登录 / 管理后台 | `matchmaker/account.cjs`、`matchmaker/public/admin.html` | `account-and-dashboard` | 重启 matchmaker |
| **刷新不掉出房间：`onDisconnect` 漏查隐身观战席位**（`roomOf()` 认座位/普通观战/隐身观战三种身份，取 seat 却只查前两种 → 隐身观战者断线时 `seat.connected` 抛 TypeError，`startGrace`/`broadcastState`/`leftHumanLeftAt` 全被跳过，房间状态与真实情况脱节。线上 2026-10-26～30 共 12 节点 31 次）。`startGrace` 定时器里同样的取席方式也一并改（不崩，但隐身观战者过期后永不移除） | `server/lobby.js`（`onDisconnect` 用 `seatOf \|\| watcherOf`、`startGrace` 定时器同） | `game-core-server` / `server-idle-guard` / `client-room-spectator` | **重启节点** |
| **素材地址改写正则取太早 → 大量图片走外站**（2026-10-30，**立绘/头像「半天不出来」的根因**）：`const REMOTE_ASSET_RE = __spRemoteAssetRe()` 是模块级常量，在模块求值时就算死；而模块常在 `window.__SP__.data`（manifest）就绪**之前**求值（实测 DOMContentLoaded 224ms、data 388ms），那一刻 `assetOrigin` 读不到 → host 为空 → 正则退化成 `^https?:\/\/\/assets\/` → **永远匹配不上**，`localAssetSrc()` 原样返回资源站地址，所有图片走外站（单文件最慢 3.4s）。且不 404、不报错，日志里完全看不出来。改成**每次调用时现算** | `public/js/ui/gameComponents.js`（`localAssetSrc`）、`public/js/assets.js`（`localizeOne`）、`public/js/audio.js`（`externalToProxy`） | `game-core-client-ui` / `game-core-client-core` | **刷新页面** |
| **素材日志带 IP**（排查「小文件也要 3 秒」需要知道是哪些玩家在卡）：`log_format sp_asset` 加 `ip=$remote_addr req=${request_length}B`，插在 `uri=` 之前，行尾格式不变 | `nginx/conf/nginx.conf` | 部署配置（`deploy/nginx.conf`） | `restart-nginx.mjs --apply` |

### 网络与性能

| 功能 | 涉及文件 | 所属补丁 | 生效方式 |
|---|---|---|---|
| **合并轮询 `/api/pulse`** | `matchmaker/server.js`（新端点）、`matchmaker/public/client.js`（refreshPulse / onPulse / getPulse） | `matching-party` / `client-announcement` | **重启 matchmaker**（前端刷新即可） |
| **client.js 版本自检**（matchmaker 改动自动下发） | `matchmaker/server.js:clientBuildTag()`、`matchmaker/public/client.js:checkClientBuild()` | `matching-party` / `client-announcement` | **重启 matchmaker** |
| **nginx 缓存键归一化**（`~hash` 剥离） | `nginx/conf/nginx.conf`（`map $uri $sp_asset_cache_uri` + `proxy_cache_key`） | 部署配置（`deploy/nginx.conf`） | `nginx -s reload` |
| 缓存预热工具 | `tools/warm-cache.mjs` | 不入补丁（运维工具） | 手动运行 |
| 缓存体检/调优工具 | `tools/augment-cdn.mjs` | 不入补丁（运维工具） | 手动运行 |
| 资源本机优先 + 缺失回源 | `nginx/conf/nginx.conf`（`/assets/` + `@assets_origin`）、`public/js/assets.js`、`public/js/assetPack.js` | 部署配置（见 `deploy/nginx.conf`） | `nginx -s reload` |
| `sw.js` 永久 no-cache | `server/http/files.js:cacheControlFor()` | `game-core-server` | **重启节点** |
| 资源站进 nginx 缓存 | `nginx/conf/nginx.conf`（`proxy_cache sp_assets`） | 部署配置 | `nginx -s reload` |

### 界面

| 功能 | 涉及文件 | 所属补丁 | 生效方式 |
|---|---|---|---|
| 公告条 | `matchmaker/public/client.js` | `client-announcement` | 刷新页面 |
| 观战 / 房间旁观 | `public/js/screens/*`、`matchmaker/public/client.js` | `client-room-spectator` / `client-watch` | 刷新页面 |
| 游客建房 | `public/js/screens/lobby.js`、`matchmaker/public/client.js` | `client-guest-create` | 刷新页面 |
| 表情弹幕 | `public/js/ui/*` | `client-emote-danmaku` | 刷新页面 |
| 资源缓存（资源包） | `public/js/assetPack.js`、`public/js/assets.js` | `client-asset-cache` | 刷新页面 |
| 商店布局 | `public/js/screens/shop.js` | `client-shop-layout` | 刷新页面 |
| 皮肤导入/导出 | `public/js/ui/skinIO.js` | `client-skin-io` | 刷新页面 |
| 标题界面 Q群按钮定位 | `matchmaker/public/client.js:2022`、`shared/public/css/screens/title.css` | `matching-party` / `game-core-client-style` | 刷新页面 |
| 版本号右下角对齐 | `shared/public/css/screens/title.css`（`.title-foot__meta`） | `game-core-client-style` | 刷新页面 |
| **房间玩家标签唯一样式源**（控制台 `:3080` 与管理后台 `:3090` 共用，避免各写一份改一边忘一边） | `shared/admin-ui/room-tags.css`（经 `/__admin-ui/room-tags.css` 由两侧 Node 提供；nginx 需有对应转发，见手册 §9.22）、`dashboard/public/index.html`、`matchmaker/public/admin.html`（**不进仓库**） | `admin-ui-shared` | 刷新页面（两侧 Node 都在跑时即可） |

### 部署与运维

| 功能 | 涉及文件 | 所属补丁 | 生效方式 |
|---|---|---|---|
| 多节点同步（**含 `server/`**） | `deploy/sync-nodes.cjs` | 不入补丁（`deploy/` 已进 IGNORE） | 手动运行 |
| 重启旧代码节点 | `tools/_restart-stale.ps1` | 不入补丁 | 手动运行 |
| 重建 nginx 开放列表 | `tools/_set-open-nodes.ps1` | 不入补丁 | 手动运行 |
| **按代码新旧维护开放列表**（每 5 分钟，SP-Open-Nodes） | `tools/sync-open-nodes.ps1`、`nginx/conf/open-nodes.conf`、`nginx/conf/nginx.conf`（`include` 与 `X-SP-Accepts-New`） | 入仓库 | 计划任务自动 reload |
| **结算页「刷新换新版本」提示** | `public/js/ui/nodeCodeHint.js`、`public/js/screens/result.js`、`public/css/screens/result.css`、`public/i18n/*.json` | 入补丁 | 玩家刷新页面 |
| 按节点号手工设开放列表 | `tools/_set-open-nodes.mjs` | 入仓库 | 写 `open-nodes.conf` + reload |
| nginx 配置备份 | `deploy/nginx.conf` | 入仓库 | `nginx -s reload` |

> ⚠ **开放列表的口径：`split_clients` 按「代码新旧」，`map $cookie_sp_route` 按「是否存活」。**
> 两者的范围**故意不同**，不要为了整齐改成一样：
> 把旧代码节点从 `map` 里摘掉 → 那台上的玩家一刷新就掉大厅（2026-10-31 事故，详见 `MAINTENANCE.md` §9.34）。
>
> 升级上游后若 `nginx.conf` 被整体替换，务必确认这两样还在：
> `include open-nodes.conf;` 和 `add_header X-SP-Accepts-New $sp_node_accepts_new always;`。
> 丢了 `include`，所有块都不生效（`_set-open-nodes.mjs` 会主动报错退出）；
> 丢了响应头，结算页提示只是不出现，不影响游玩。

### ⚠ 已知陷阱（踩过一次，别再踩）

1. **`deploy/sync-nodes.cjs` 曾经不同步 `server/`** —— 导致 29 个节点一直跑 10-25 的旧服务端代码，
   重启也拿不到新功能（2026-10-27 修复，提交 `bf9a7c58`）。
   **凡是改 `server/`，同步后再确认一次各节点内容一致**（`node deploy/sync-nodes.cjs` 应输出 `0 处差异`）。
2. **`healthz` 的 `build` 字段不覆盖 `server/net.js`、`server/lobby.js`、`server/match/**`** ——
   不能靠 build 相同判断服务端已更新，要用「进程启动时间 vs 文件 mtime」。
3. **`Copy-Item` 会保留源文件 mtime** —— 复制到各节点后 mtime 看起来还是旧的，
   用内容哈希或 `deploy/sync-nodes.cjs` 的差异报告核对，不要只看时间戳。
4. **前端/服务端两层的改动要分别验收** —— 例如 DOCTOR # 需要服务端下发 tag，
   旧节点上前端会自动回退到哈希，看起来"没坏"但功能没生效。
5. **静态文件"部署完成"不等于"玩家已生效"** —— 页面加载后模块留在内存里，服务器更新送不到
   已打开的标签页。节点侧靠 `ui/buildGuard.js` 盯 `/healthz.build` 自动刷新，但那个
   `buildTag` **不含 `matchmaker/`**。所以改 `matchmaker/public/client.js` 后，要么等玩家
   自己刷新，要么靠 `/api/pulse` 带回来的 `clientBuild` 自检（本服新增，见上表）。
   验证方式：看 access.log 里新端点是否开始被大量调用，而不是只看文件已部署。
6. **改 `server/` 后不能只跑 `deploy/sync-nodes.cjs --apply`** —— 它把 **node-1 当母版**，
   只保证 node-2…30 和 node-1 一致；如果改动是在 `repo-sync/server/` 里做的、还没进 node-1，
   脚本会诚实地报 `0 处差异`（因为大家一样旧），**改动等于没发**。
   正确的判断方式：拿 `repo-sync/server/<file>` 的哈希和节点上的比（参考第 3 条）。
   2026-10-27 的 `room.join` 修复就差点在这上面漏掉（见第 7 条）。
7. **`room.join` 的冲突判定顺序必须"同房间 → 接管"在前** —— 先无条件
   `dropStaleAccountSeats()` 会把**同一账号在目标房间自己的座位**当成遗留座位删掉；
   若那是房间唯一的人类座位，房间会直接 `disposed (empty)`，玩家开新标签页回来时
   报「未找到该同盟密钥对应的房间」。回归测试：`node test/join-takeover-order.mjs`。
8. **接管后的三条前端提示要一起看** —— 玩家实测同时看到「该身份已在其他页面登录」
   「正在进入模拟…（卡住）」「对局已转移，但观战席不可用」，这是**一条链上的三个坑**，
   只修其中一个仍然不可用：
   - `room.state` 可能早于 `welcome` 到达，这期间 `store.me.playerId` 还是旧会话的，
     `onRoomState` 会误判「座位里没有我」而清空房间 → 卡「正在进入模拟…」；
     用 `net.playerIdPending` 跳过这段时间的身份比对。
   - 旧标签页被接管后**不要**再去 `room.spectate`：那座位现在的 `accountId` 还是自己，
     `accountRoomConflict` 必然判 `SESSION_IN_USE` →「观战席不可用」。直接回大厅。
   回归测试：`node test/takeover-full-chain.mjs`；真实链路：`node tools/_verify-join-takeover-live.mjs 1`。
9. **恢复对局一律不许自动跳转**（维护者 2026-10-27 要求）—— 曾经有 6 条自动路径，
   玩家打开页面 / 刷新 / 换设备就被页面自己跳走，换设备那次还会把原来那台顶下线。
   现在唯一入口是大厅「恢复对局」按钮；跨节点的跳转也必须是玩家**再点一次**
   （`resumeMatch.js` 的 `goToRoom`），并且靠**一次性**的 `sp.accountResume` 标记
   （读完即删，所以刷新不会再触发）。
   **改这块之前先跑 `node test/manual-resume-only.mjs`**，它会扫全站确认没有任何
   「不由点击触发」的 `accountResume` 跳转。
10. **换设备点「恢复对局」卡在「正在进入模拟…」的真凶是 `identity.adopt` 不存在** ——
    `adoptAccountSeat` 里写了 `identity.adopt(msg.token)`，但 `net.js` 的 `createIdentity()`
    只暴露 `saveToken / rejectToken / getToken …`，**没有 `adopt`**。于是每次接管都抛
    `TypeError`：token 从未被采用 → 不重连 → 服务端不再推 `room.state`/`m.public` →
    页面永远停在「正在进入模拟…」。异常从 net 事件回调里抛出，`done()` 不会执行，
    所以还要干等 8 秒超时，看起来像"转圈然后卡死"。
    **正确写法：`identity.saveToken(msg.token)` 然后用新 token 重连。**
    这类"调用不存在的成员"语法检查发现不了（合法 JS），所以专门加了守卫：
    `node test/identity-members-exist.mjs`（把全仓 `identity.xxx` 和 net.js 实际成员比对）。
    真实链路验证：`node tools/_verify-crossdevice-resume.mjs 4 --start`
    （注意必须模拟前端「拿 token 后断开重连」那一步，否则是假阴性）。
11. **重启节点前要先清 Redis 里的死房间，否则重启后房间又被恢复** ——
    房间状态会持久化到 Redis（`sp:nN:lobby:rooms` 是 **hash**，`type` 是 hash，
    用 `get` 会报 WRONGTYPE，要用 `hkeys` / `hdel`）。只重启进程的话，
    服务端启动时会把 Redis 里的房间读回内存，`rooms` 数不变 ——
    表现为"重启了什么都没变"。清理顺序：`hdel sp:nN:lobby:rooms <CODE>` → 再重启节点。
    **删之前先确认 `matches=0` 且 `sockets=0`**（无人连接），别误删活房间。
12. **判断"能否重启"只看 `matches`，不要看 `rooms`** ——
    维护者明确的口径：**有对局（`matches>0`）就不动；`matches=0` 就可以重启**，
    哪怕是开着未开局的房间、有待机连接、有旁观者。
    `rooms>0 && matches=0` 的节点（空壳房、等待室）都能安全重启。
    现成的工具：`tools/_restart-when-idle.ps1`（默认只报告，`-Apply` 才重启；
    重启前会自己复查一次 `matches`）。
13. **`sp.matchInterrupted` 是 localStorage（跨标签页共享、30 分钟），不能当作「本页状态」** ——
    它记录的是「最近一次正在打的那一局」。踩过两个坑：
    - **任何新标签页都弹「本局模拟已结束」**：因为 `resumeTick` 里原本「只要没房间就弹面板」。
      现在要求 `s.room.code === rec.code` 才弹（本页确实进过那间房）。
    - **点「返回同盟」回到的是新开的对局**：按钮里先读标记拿到旧房号，紧接着
      `if (inRoom) code = s.room.code` 用**当前房间**把它覆盖掉，然后只 `location.reload()`。
      在新标签页点就等于原地刷新新房。现在以标记里的房间码为准，不一致就显式跳过去。
    回归测试：`node test/restart-panel-scope.mjs`。
14. **实验性选项弹窗的下拉：不要"预留空间"，也不要移动元素躲菜单** ——
    维护者 2026-10-27 的原话：「不要预留下拉框的空间」「窗口整体拉大、不要出现滑动条」
    「下拉框可以遮挡下面的按钮的」「这个界面一直弹来弹去的好看吗」。
    结论：**弹窗尺寸恒定 + 元素零位移 + 菜单正常遮挡下方内容**（点外面收起），
    这才是要的效果。踩过的三个坑：
    - 给 `.exp-modal__body` 加 `padding-bottom` 预留 → 内容区被撑高，
      `.modal` 是 `place-items:center`，弹窗一变高就整体上移，所有元素位移 20px。
    - 写 `align-self: start` 想让布局稳定 → 弹窗被钉到屏幕最上方。
    - 展开时把开关推下去 → 弹窗跳一下，比遮挡更难看。
    另一个隐性问题：`overflow-y: visible` 单独写**无效**。基础规则是
    `overflow: hidden auto`，CSS 规定一边 visible、另一边不是时 visible 会被计算成 auto，
    必须用 `overflow` 简写把两个方向都设成 visible。
    回归测试：`node test/exp-modal-dropdown.mjs`（四档尺寸，检查位移/滚动条/可点击）。
15. **🚫 红线：绝不能在 AI 助手 / 终端 / 任何交互式 shell 里启动 PM2**（2026-10-27 全体玩家断线）——
    pm2 会挂在那个会话的进程树下面，**那个应用一重启，pm2 跟着死，30 个节点全没**。
    当天维护者重启 AI 助手，玩家看到「与服务器的连接已中断，正在重连（第 7 次）」。
    而当时的看门狗只写 `ALERT` 从不修复，所以断了 3 分钟没人救。
    **正确做法**：双击 `启动服务器.bat`（内部走 `schtasks /Run /TN "SP-PM2-Resurrect"`，
    SYSTEM 身份 + Session 0，与任何登录会话无关）。
    **每次动过运维配置都要做冷杀测试**：杀掉 pm2 → 60 秒内必须自己回来。
    完整经过、验证命令、排查表见 [MAINTENANCE.md](../MAINTENANCE.md) **§9.9**。
    同一条红线也在 [AGENTS.md](../AGENTS.md) 的「更新 GitHub 前必查清单」里。
16. **验证 nginx 配置改动必须「绕过缓存」**（2026-10-27 踩过）——
    `/assets-cdn/` 的语义是 `proxy_pass .../assets/`：请求 `/assets-cdn/spine/x` → 源站
    `/assets/spine/x`。有人（包括我）会以为 `/assets-cdn/assets/spine/x` 才是对的，
    改成 `proxy_pass https://assets.luobomiao.love/;` —— **这是错的，会把原本正常的
    路径也弄坏**，因为源站只有 `/assets/...` 一种路径（`/spine/...` 直接 404）。

    最坑的是：改完测试**全部 200**，看起来修好了 —— 实际是**命中了旧缓存**
    （`X-SP-Asset-Cache: HIT`），根本没回源。

    **正确验证方式**：
    - 换一个**从未请求过**的文件（`Get-ChildItem shared/assets -Recurse | Select -Skip N`）；
    - 或看响应头 `X-SP-Asset-Cache`：`MISS`/`BYPASS` 才是真的走了新逻辑，`HIT` 什么都不算；
    - 注意 `proxy_cache_key "$sp_asset_cache_uri"` **不受 proxy_pass 影响**，
      改回源路径不会让旧缓存失效，所以你测到的可能是几天前的条目。

    `deploy/nginx.conf` 是这份配置的备份（`nginx/conf/nginx.conf` 不进仓库）。

17. **看门狗绝不能把「读不到」当成「全都没了」**（2026-10-28 连环事故）——
    `_stack-watchdog.ps1` 原来这样写：

    ```powershell
    cmd /c "pm2 jlist > tmp 2>nul"      # 失败静默返回空
    $online = @($r.out -split ',')      # → 空数组
    $missing = <全部 32 个应用>          # 全被判成"缺失"
    pm2 resurrect                        # ← 重启整张进程表
    ```

    `pm2 jlist` 在 pm2 忙时会**间歇性失败**，一次抖动就让看门狗以为「所有应用都丢了」，
    然后 `resurrect` 把全服重启一遍。**实测一次误判中断了 10 局对局**，玩家体感
    「一直在重启」。

    同一天这条链的上游还有一环：`nginx-gateway`（pm2 里托管 nginx 的 wrapper）与
    计划任务 `SP-Nginx-Start` 抢 443，前者崩溃循环 **4321 次**。

    **三条通用规则**（写任何「检测→修复」脚本都适用）：
    - **先区分「真的坏了」和「我读不到」**。读取失败 / 结果为空 / 明显不完整 → 这一轮
      **什么都不做**，只记日志；
    - **`pm2 resurrect` 是高危操作**，只用于「pm2 守护进程整个挂了」（那时所有应用本来就
      都没了）。补缺失应用一律 `pm2 start <eco> --only <name>`；
    - 换托管方（例如 nginx 从 pm2 挪到计划任务）必须**先停旧的再起新的**，只做一半会让
      两者抢同一个端口。

    排查入口：`pm2 jlist` 看 `restart_time`（几百上千次 = 崩溃循环），
    巡检日志 `logs\restart-watch.log`。完整经过见 [MAINTENANCE.md](../MAINTENANCE.md) **§9.12**。
18. **新增 `g.*` / `room.*` 消息类型，必须同时加进 `shared/protocol.js` 的 `C2S` 白名单**（2026-10-28 踩过）——
    `server/net.js` 在把请求交给对局之前先查白名单，缺了就直接回 `ERR.BAD_MSG`（「无效的请求」），
    **请求根本到不了业务逻辑**。复活（`g.revive`）就是这样丢的：客户端按钮、`Match.revive()`、
    `intents.js` 的路由全都在，唯独白名单那一行在上游同步时被抹平了，玩家点了只看到「无效的请求」。
    症状的迷惑之处：玩家说「我没漏怪、血也够」，但这些条件属于业务层的判断，**从来没被读到过**。
    日志里也看不出来 —— `unknown type` 只回给客户端，不写服务端日志。
    验证：`node tools/verify-revive.mjs <节点号> <userToken>`，看回复是 `BAD_MSG`（没修好）
    还是 `WRONG_PHASE / no running match`（已放行到业务层）。详见 [MAINTENANCE.md](../MAINTENANCE.md) **§9.14**。

### 回归测试清单（改相关代码后要跑）

| 测试 | 守住什么 |
|---|---|
| `node test/join-takeover-order.mjs` | `room.join` 必须「同房间 → 接管」在「清理遗留座位」之前 |
| `node test/takeover-full-chain.mjs` | 接管后的完整链路：`net.playerIdPending` 竞态、旧标签页回大厅 |
| `node test/manual-resume-only.mjs` | 全站不得有「不由点击触发」的恢复跳转 |
| `node test/identity-members-exist.mjs` | 所有 `identity.xxx` 调用都必须是 `net.js` 真实存在的成员 |
| `node test/restart-panel-scope.mjs` | 「本局模拟已结束」只对进过那间房的页面显示；返回同盟跳对房间 |

真实链路工具（要连线上节点，会真的建房，用完注意清理）：

| 工具 | 验证什么 |
|---|---|
| `node tools/_verify-join-takeover-live.mjs 1` | 开新标签页回自己房间，房间不被解散 |
| `node tools/_verify-crossdevice-resume.mjs 4 --start` | 换设备恢复：`account.resume` → 重连 → 收到 `room.state` / `m.public` |

> 注意第 2 个工具**必须模拟前端「拿 token 后断开重连」那一步**，否则服务端不会推状态，
> 得到的是假阴性（我第一版就漏了这一步）。
> 这两个工具会在节点上留下房间；`matches=0 sockets=0` 时可重启节点 +
> `hdel sp:nN:lobby:rooms <CODE>` 清掉（见第 11 条）。

## 两个一键脚本（在仓库根目录）| 脚本 | 作用 |
|---|---|
| `apply-patch.bat` | 打补丁 → 同步到 node-1…node-30 → 重启 PM2 |
| `restore-patch.bat` | 还原官方文件 → 重启 PM2 |

## 官方更新时的标准流程

1. **先跑 `node patcher/check-coverage.mjs`**，确认当前没有未覆盖的改动；
2. 双击 **`restore-patch.bat`** —— 恢复官方版本；
3. 按官方方式应用更新包（服务器能正常启动）；
4. 双击 **`apply-patch.bat`** —— 在新版本源码上重新打上补丁并重启；
5. **再跑一次 `node patcher/check-coverage.mjs`**，确认功能都回来了。

> 补丁是**按锚点插入**的，不覆盖整份文件，所以新版本里的其它改动都会保留。
> 如果新版本改动了锚点，`apply-patch.bat` 会在写文件**之前**中止，并打印是哪一条找不到锚点。

## 单独使用（命令行）

```powershell
node patcher\apply.mjs             # 打补丁
node patcher\apply.mjs --check     # 检查是否已全部打好（不改文件）
node patcher\restore.mjs           # 还原
node patcher\restore.mjs --check   # 检查是否已是官方原版
node patcher\check-coverage.mjs    # 补丁完整性
```

## 断点快照（服务器重启 / 意外关闭）

`server/lobby.js` 里还加了快照逻辑：

- 每 10 秒把「房间 + 座位 + 重连 token」写到 `node-N\state\snapshot.json`；
- 正常关机（PM2 stop/restart、SIGTERM）时再写一次；
- 进程重新起来时自动读回：房间码不变、座位不变，玩家浏览器用原来的 token 重连会**回到同一个房间**；
- 开服后 **30 分钟内没有任何真人回来的房间自动作废**（不会把很久以前的空房间一直挂着）；
- 对局**本身**不能续跑（引擎状态在内存里），重连时会提示「服务器重启，上一局模拟已中断，可重新开始」，然后原地重新开局。

关闭方式：节点的环境变量 `SP_SNAPSHOT=0`（默认开启）。

## 对局检查点（Redis 检查点的第一步）

- 每 10 秒把进行中的对局写入 `node-N\state\matches\<房间码>.json`（回合、阶段、玩家资金/棋盘/商店等）；
- 重启后玩家重连时自动把对局挂回去（同一回合/阶段），见 `server/match/checkpoint.js`；
- 对局同时双写到 Redis（`SP_REDIS_URL`，默认 `redis://127.0.0.1:6379/0`），启动时本地文件缺失会用 Redis 的存档补齐；
- 已验证：第 0 回合与第 2 回合恢复、删除本地文件后从 Redis 恢复。

## 环境变量（防护参数）

在 `ecosystem.config.cjs` 每个节点的 `env` 里：

```js
SP_MAX_ROOMS_PER_ADDR: '1',      // 同一 IP 同时存在的房间数（0 = 关闭）
SP_MAX_BOTS_PER_ADDR: '6',       // 同一 IP 跨房间累计的 AI 队友数（0 = 关闭）
SP_IDLE_KICK_MS: '240000',       // 多久没有操作就踢出房间（0 = 关闭）
```

改完需要让 PM2 重新读取环境：`pm2 start ecosystem.config.cjs --update-env`（两个 bat 已经这么做了）。
