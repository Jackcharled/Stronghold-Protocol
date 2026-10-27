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
| 5–20 人同盟（容量实验） | `server/match/Match.js`、`server/match/match/phases.js`、`shared/playerCapacity.js`、`shared/experimental.js`、`public/js/screens/room.js` | `server-player-capacity` | 重启节点 |
| 并发草稿（仅 allowRepeat 时） | `server/match/Match.js:concurrentDraft()`、`server/match/match/phases.js` | `game-core-match` | 重启节点 |
| 悬赏决策公共计时 | `server/match/match/spDraft.js:_concurrentSpStep()` | `game-core-match` | 重启节点 |
| 跳过按钮（仅非 allowRepeat） | `public/js/match/matchChrome.js:StepHeader`、`server/match/match/phases.js` | `game-core-match` | 刷新页面 + 重启节点 |
| **鸭爵策略可叠加**（实验开关） | `server/sim/content/bands/meta.js:duckGlobal`、`server/match/Match.js`、`server/match/gamedata.js`、`server/match/snapshot.js`、`shared/experimental.js`、`public/js/screens/room.js` | `game-core-server` / `server-snapshot-checkpoint` / `server-player-capacity` | **重启节点** |
| 禁用鸭爵策略（5–20 人） | `server/match/gamedata.js`、`shared/experimental.js`、`public/js/screens/bandDraft.js` | `server-player-capacity` | 刷新页面 + 重启节点 |
| 挂机踢人 / 同 IP 限制 | `server/match/match/intents.js` | `server-idle-guard` | 重启节点 |
| 房间/对局快照与 Redis 检查点 | `server/match/snapshot.js`、`server/persist/*` | `server-snapshot-checkpoint` | 重启节点 |

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
| **DOCTOR # 显示真实账号 tag** | `server/lobby.js`（`room.state seats[].tag`）、`public/js/screens/room.js:seatNo()` | `game-core-server` / `server-player-capacity` | **重启节点**（前端回退到哈希） |
| **名片立绘跟随账号** | `matchmaker/account.cjs`（DOMAINS + validatePrefPayload + decodePrefPayload）、`matchmaker/public/account-title.js:PREF_MAP.card`、`public/js/ui/seatArt.js` | `account-and-dashboard` / `matching-party` | 重启 matchmaker |
| 账号登录 / 管理后台 | `matchmaker/account.cjs`、`matchmaker/public/admin.html` | `account-and-dashboard` | 重启 matchmaker |

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

### 部署与运维

| 功能 | 涉及文件 | 所属补丁 | 生效方式 |
|---|---|---|---|
| 多节点同步（**含 `server/`**） | `deploy/sync-nodes.cjs` | 不入补丁（`deploy/` 已进 IGNORE） | 手动运行 |
| 重启旧代码节点 | `tools/_restart-stale.ps1` | 不入补丁 | 手动运行 |
| 重建 nginx 开放列表 | `tools/_set-open-nodes.ps1` | 不入补丁 | 手动运行 |
| nginx 配置备份 | `deploy/nginx.conf` | 入仓库 | `nginx -s reload` |

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

## 两个一键脚本（在仓库根目录）

| 脚本 | 作用 |
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
