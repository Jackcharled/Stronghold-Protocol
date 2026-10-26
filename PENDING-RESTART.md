# 待生效改动与重启清单

最后更新：2026-10-26 16:47
状态：**15 个节点已跑最新代码并对外开放；15 个节点仍有对局，已停止接收经由匹配进来的新玩家**

---

## 【最新】2026-10-26 16:42–16:47 联防时间提示改真实秒

### 改了什么

玩家看到的联防时间提示一律用**真实秒**，不再出现「游戏秒」字样。

| 位置 | 改前 | 改后 |
|---|---|---|
| 顶栏 HUD（`public/js/ui/hud.js`） | `联防时间：75 秒（150 游戏秒）` | `联防时间：75 秒` |
| 跑马灯（`server/match/match/unitePhase.js`） | `…（本段 150 游戏秒）` | `…（本段 75 秒）` |

**数字本身不变**，只是去掉括号里的内部单位说明。跑马灯那条必须换算是必须的：
它原来直接打印 `plan.timeLimit`（游戏秒 150），而 HUD 显示的是 `150 / gameSpeed = 75`，
两个数摆在一起会互相矛盾。现在统一成 `unitePhase.js` 新增的 `_uniteRealSecs()`
（`gameSeconds / gameSpeed`，2 倍速下 300 → 150、150 → 75）。

> 预算结构备忘：总预算 **300 游戏秒 = 150 真实秒**；可接力时分两段 `[150, 150]` 游戏秒，
> **每段 75 真实秒**。不要把「总预算 150 秒」和「每段 75 秒」搞混。

### 本轮节点处置（16:44 复核）

| 处置 | 节点 | 依据 |
|---|---|---|
| **已重启 + 对外开放**（15） | 2, 4, 5, 6, 7, 8, 15, 17, 21, 22, 24, 25, 26, 27, 30 | 重启前后两次采样 `rooms/matches/humans` 均为 0 |
| **未重启 + 已限制**（15） | 1, 3, 9, 10, 11, 12, 13, 14, 16, 18, 19, 20, 23, 28, 29 | 仍有玩家在对局中 |

`MM_DISABLED_NODES` 已更新为后者，匹配器 16:46 重载，启动日志确认：

```
[mm] 暂停接收新玩家的节点: 1,3,9,10,11,12,13,14,16,18,19,20,23,28,29
```

**5–20 人大厅不受影响**：实验节点 `EXPERIMENTAL_NODE`（默认 node-4）在开放列表内，
已重启且空闲，多人大厅照常可用。

`hud.js` 是静态文件（刷新即生效）；`unitePhase.js` 是后端，需节点重启才生效——
所以现在**只有那 15 个开放节点**跑的是新代码，受限的 15 个跑马灯仍显示旧文案，
等它们对局结束、重启后自动跟上。

---

## 2026-10-26 16:30–16:35 上一轮重启与限制记录

### 判定依据

以磁盘上最新的两个后端文件为「最新代码」基准：

| 文件 | 修改时间 |
|---|---|
| `server/match/bot.js` | 16:25:57 |
| `server/match/match/spDraft.js` | 16:28:37 |

节点启动时间 = 当前时间 − `uptimeSec`。**启动早于 16:28:37 即为缺代码**。
（30 个节点的磁盘代码经哈希比对**完全一致**，差别只在进程是否重读了代码。）

### 一、已重启（19 个）—— 现已运行最新代码

重启方式：`pm2 startOrReload ecosystem.config.cjs --only node-N --update-env`，
完成后 `pm2 save`。**每次重启前都实时复核了 `sockets/rooms/matches`。**

| 批次 | 节点 | 说明 |
|---|---|---|
| 首批空闲 | 1, 2, 3, 4, 6, 7, 8, 15, 21, 22, 24, 25, 26, 27 | sockets/rooms/matches 全为 0 |
| 二批空出 | 5 | 复核两次采样均无负载 |
| 三批空出 | 9, 14, 17, 30 | 曾有 1 个 socket，经查是**节点自身到本机 127.0.0.1 的内部连接**（对端 pid 即节点自身），Redis 无会话记录、`humans=0`，确认无玩家 |

> node-17 第一批因有 socket 被跳过，核实为自身内部连接后才重启。

**当前状态：以下 19 个节点全部运行最新代码**

```
node-1  node-2  node-3  node-4  node-5  node-6  node-7  node-8  node-9
node-14 node-15 node-17 node-21 node-22 node-24 node-25 node-26 node-27 node-30
```

### 二、已限制对外开放（11 个）—— 仍在跑旧代码，有真实对局

这 11 个节点上还有玩家在对局中，**不能重启**。改为**停止接收新对局**：
已有的对局照常打完，只是匹配器不再把新玩家调度过去。

```js
// ecosystem.config.cjs → matchmaker.env
MM_DISABLED_NODES: '10,11,12,13,16,18,19,20,23,28,29',
```

| 节点 | 限制时的负载 (sockets/rooms/matches) |
|---|---|
| 10 | 3 / 1 / 1 |
| 11 | 1 / 1 / 0 |
| 12 | 4 / 1 / 1 |
| 13 | 3 / 3 / 3 |
| 16 | 2 / 1 / 1 |
| 18 | 2 / 1 / 1 |
| 19 | 3 / 1 / 1 |
| 20 | 8 / 1 / 1（7 名真人） |
| 23 | 2 / 1 / 1 |
| 28 | 3 / 1 / 1 |
| 29 | 1 / 1 / 1 |

### 三、代码改动（`matchmaker/server.js`）

新增环境变量 `MM_DISABLED_NODES`（逗号分隔节点号），并接入三处：

1. `pickNode()` —— 过滤掉禁用节点，不再被选为新对局节点
2. `pickNodeFor()` —— 5–20 人实验节点（默认 node-4）若被禁用也会跳过
3. `/api/state` 的 `nodes[]` 增加 `disabled` 字段，后台可直观看到

启动时会在日志打印一行，便于确认配置已加载：
```
[mm] 暂停接收新玩家的节点: 10,11,12,13,16,18,19,20,23,28,29
```

匹配器已重启并验证生效（`pm2 env` 与启动日志双向确认）。

> **为什么限制不等于断线**：禁用只影响**匹配器把新玩家分配到哪个节点**，
> 不触碰已有连接、不踢人、不解散房间，房间里的人照样能打完、继续开局、被邀请进房。玩家在打的局完全不受影响。

### 四、后续恢复步骤

当这 11 个节点的 `rooms` 和 `matches` 都归零后：

```powershell
# 1. 确认确实空下来了（逐个查，不能只看 uptime）
foreach ($n in 10,11,12,13,16,18,19,20,23,28,29) {
  $j = Invoke-RestMethod "http://127.0.0.1:$((3000+$n))/healthz" -TimeoutSec 2
  "node-$n s=$($j.sockets) r=$($j.rooms) m=$($j.matches) h=$($j.humans)"
}

# 2. 重启这些节点
pm2 startOrReload ecosystem.config.cjs --only "node-10" --update-env   # 逐个，或写循环
pm2 save

# 3. 从 ecosystem.config.cjs 删掉 MM_DISABLED_NODES（或改成空字符串），重载匹配器
pm2 startOrReload ecosystem.config.cjs --only matchmaker --update-env
pm2 save
```

**不要**在节点还有 `rooms > 0` 时重启 —— 对局进程会直接消失，玩家掉线。

---

## 最近一次重启的结果（13:15）

按「不影响正在对局的玩家」执行：

| 对象 | 操作 | 说明 |
|---|---|---|
| matchmaker | 已重启 | 独立进程，不影响进行中的对局 |
| 20 个无连接节点 | 已用 `startOrReload --update-env` 重载 | node-15 有人刚连上，跳过 |
| 9 个有玩家的节点 | **未重启** | node-2/3/10/11/19/20/22/27/28 |

**已验证生效**：
- `SP_MAX_ROOMS_PER_ADDR = 3`、`SP_EXPERIMENTAL = 1`（dump.pm2 已确认，`pm2 save` 已存）
- 匹配按人数独立成池：`node test\e2e-capacity-match.mjs` 全部通过
  （此前 4/5/8/12/16/20 六个房会全被配进同一个 4 人局，现在各池独立）
- 抽查 node-2/3/10/19/27/28（未重启）也能建 12 人房

**仍待重启**：node-2、node-3、node-10、node-11、node-19、node-20、node-22、node-27、node-28
（有玩家在线，等他们空下来再重启；重启前务必先查 `sockets`）

> 注：`pm2 restart --update-env` **不会**重读 `ecosystem.config.cjs`，
> 必须用 `pm2 startOrReload ecosystem.config.cjs --only node-N --update-env`，
> 然后 `pm2 save`。这一点已实测确认。

---

## 一、已改好、已推 GitHub、已同步 30 节点，但还没生效

这些改动在磁盘上都已就位，只是进程还在跑旧代码，**必须重启才生效**。

### 0. 5–20 人房对所有玩家开放 + 匹配支持任意人数
**现状问题**：
- 前端建房时**只有 owner/admin** 能开多人大厅（`experimentalForCreator` 里
  `if (!role || role === 'player') return null`），普通玩家建房永远是 4 人
- `SP_EXPERIMENTAL` 只在 **node-4** 打开
- 结果：全服只有一台机器能开多人大厅，匹配池里几乎见不到 5 人以上的局

**改了什么**：

| 文件 | 改动 | 生效方式 |
|---|---|---|
| `public/js/screens/lobby.js` | 去掉角色限制；同盟选择页加「同盟人数」下拉（4/5/6…20）；记住上次选择 | 刷新即生效 |
| `public/css/screens/lobby.css` | 下拉样式 | 刷新即生效 |
| `server/persist/lobbyState.js` | ★ 房间文档补存 `capacity` | 需重启 |
| `server/persist/lobbyState.js` | ★ 房间文档补存 `version`（见下面「版本隔离」） | 需重启 |
| `matchmaker/server.js` | ★ 容量解析兜底读 `experimental.playerCapacity` | 需重启 matchmaker |
| `ecosystem.config.cjs` | ★ `SP_EXPERIMENTAL: '1'` 给所有节点 | 需重启 |

**为什么 `lobbyState.js` 那条是必须的（重要）**：

匹配端 `roomInfo()` 读的是 `doc.capacity`，但房间文档里**从来没存过这个字段**，
只存了 `experimental`（其中虽有 `playerCapacity`，但 matchmaker 不认）。
于是所有房间在匹配池里都被当成 **4 人**——

实测复现：同时开 4/5/8/12/16/20 人房进池，日志显示
`房间 XXXXX@1 开始匹配 · 1/4 人`，六个不同人数的房**全被配进同一个 4 人局**。

修好后各人数独立成池，只有相同人数才会匹配到一起。

**验证**：
```
node test\e2e-capacity-match.mjs 3001
```
（重启前跑会看到「6 个房被误配」的失败，这是预期的——重启后应全过）

---

### 1. 对局结束 / 中途退出后不能建房

**玩家反馈**：对局结束或中途退出后，建房按钮点了没反应 / 提示不能创建。
**实测证据**：nginx 与节点日志里有 4 个不同 IP 撞了 `room limit (1)`，
每次都是连续重试十几次（`+10 similar refusals`）。玩家雾灯在 10:44–10:47 撞了 13 次。

两个原因，都已修：

| # | 原因 | 修改 |
|---|---|---|
| 1 | `accountRoomConflict` 只比 `playerId`。刷新页面/换设备后拿到新 `playerId`，旧房间座位还挂着同账号，被判成「该账号已在其他房间中」，可玩家界面上看不到那个房间、也没入口离开，只能等 15 分钟超时 | 新增 `dropStaleAccountSeats()`，建房/加入/观战前先清理「同账号 + 旧会话已断线」的遗留座位；`conflict.stale` 标记 |
| 2 | `SP_MAX_ROOMS_PER_ADDR = 1`，同一网络（宿舍/家庭/网吧）只能有一个房间，第二个人建房直接被拒 | 放宽到 **3** |

**设计没有放松**：一个账号仍只能在一个房间里（`one-room-per-account` 测试 11/11 通过）。

**涉及文件**：
- `server/lobby.js`（`accountRoomConflict`、`dropStaleAccountSeats`、三处调用点）
- `ecosystem.config.cjs`（`SP_MAX_ROOMS_PER_ADDR: '1'` → `'3'`）

**验证**：
```
node test\room-limit-scenarios.mjs    全部通过
node test\room-limit-three.mjs        全部通过
node test\one-room-per-account.mjs    11/11
node test\guest-cannot-host.mjs       7/7
node test\matchmaking-mechanism.mjs   14/14
```

---

### 1b. 不同版本被配进同一局（版本隔离失效）

**病根**：`lobbyState.js` 的 `roomDoc()` 存房间时**没有存 `room.version`**，
Redis 里的房间文档只有 `code, mode, capacity, experimental…`。
matchmaker 的 `roomInfo()` 读的是 `doc.version`（`sp:nN:lobby:rooms` 这个哈希），
读不到就退回客户端上报值 —— 而客户端排队时不总带这个值，
于是**所有房间在匹配池里都被当成第二期下半**，第二期上半的房会被配进第二期下半的局。

以前只查了 matchmaker 的 `groups` 分组逻辑（`normVersion` 那段本身是对的），
所以看起来「已经按版本隔离了」。真正缺的是数据源这一环。

**改了什么**：
- `roomDoc()` 增加 `version: room.version`
- `roomFrom()` / `fallbackRoom()` 恢复房间时把 `r.version` 传给 `new Room(...)`
  （否则节点重启后房间会被恢复成默认版本，版本隔离又失效）

**涉及文件**：`server/persist/lobbyState.js`

**验证**：`node test\e2e-version-match.mjs 3002` —— 全部通过。
修之前是 4 项失败（旧版 8 人房的队列版本被记成 `act2autochess`、
`byVersion` 里看不到第二期上半），修之后旧版正确登记为 `act2autochess@V2_1`。

---

### 1c. 卡死的对局房间永远不会回收（node-19 的 DTTW）

**现象**：node-19 上有个房间 `DTTW`（单人 / 终极 / 1 人），玩家「月城苍」**08:20 就断线了，
再没回来**，但房间一直挂到 13:55 —— 挂了 **5 个半小时**，而房间 TTL 只有 15 分钟。
`sockets=0` 但 `rooms=1 matches=1`，`livePhase` 停在 `BAND_DRAFT`、`liveRound=0`。

**病根**：`Lobby.sweepOldRooms()` 第一行就是

```js
if (!room || room.disposed || room.match) continue;   // ← 有对局就整间跳过
```

对局进行中跳过是对的（不能因为计时器打断玩家对局），但**它没有「对局卡死」这个出口**：
只要 `room.match` 还在，房间就永远不会过期。房主断线后对局推不动，
`onMatchEnd` 永远不触发 → `lastMatchEndAt` 不更新 → 这个房间既不会结束也不会过期。

`sweepIdle` 也救不了它：它判的是 `session.connected`，断线的人直接 `continue`。

**改了什么**（`server/lobby.js`）：

1. `sweepOldRooms()` 不再无条件跳过对局房间，改成：
   - `room.noExpire`（管理员房）→ 照旧跳过；
   - **房间里只要还有一个真人在线 → 跳过**（正常对局完全不受影响）；
   - 真人都断线了，就从 `lastHumanLeftAt` 起算 TTL，超时才回收。
2. `onDisconnect()` 里，对局中最后一个真人断线时记下 `room.lastHumanLeftAt`。
3. 重连时把 `lastHumanLeftAt` 清零（人回来了，回收计时作废）。

**为什么用 `lastHumanLeftAt` 而不是 `createdAt`**：对局可能已经跑了半小时，
用建房时间算会一断线就立刻回收，玩家重连回来房间已经没了。从「最后一个人断开」起算，
玩家有完整的 15 分钟窗口回来续上。

**验证**：
```
node test\stuck-match-room.mjs    7/7 通过（新增）
```
覆盖：卡死对局被回收 / **在线对局不被打断** / 断线 5 分钟保留、16 分钟回收 /
管理员房不回收 / 多人房只要 1 人在线就保留 / 回收后给断线玩家留 notice。

`patcher\check-features.mjs`（`server-stuck-match-reap`）已加 4 条断言，
把 `continue` 改回去会同时让单测和校验器变红（破坏性测试已验证）。

**顺带修**：`test\room-limit-three.mjs` 的「刷新页面后建房」用例一直失败，但**不是线上问题** ——
它只标了 `session.connected=false`，没标**座位** `seat.connected=false`，
而真实的 `onDisconnect` 两者都会标。`dropStaleAccountSeats` 按设计
（座位还标着「连接中」就不清理）拒绝清理，所以用例永远红。改成正确模拟后通过。

---

### 1d. 管理员房离线太久也要回收

**问题**：管理员/服主建的房 `noExpire = true`，`sweepOldRooms()` 无条件跳过所有过期判定。
而 `syncNoExpire` 只在**房主换人**时重新判定 —— 只要房主一直是管理员，
`noExpire` 就永远成立。于是管理员建完房就走、再也不回来，这个房间就永远挂在那里，
比普通玩家的卡死房更糟（连 15 分钟 TTL 都不走），还会一直占着「同网络建房上限」的名额。

**改了什么**（`server/lobby.js`）：

1. 新增 `adminOwnerOnline(room)`：房主必须是**在线的** admin/服主，`noExpire` 才生效。
   `sweepOldRooms` 用 `const forever = room.noExpire === true && this.adminOwnerOnline(room);`
   —— 不再只看 `noExpire` 这个静态标志。
2. 新增 `room.adminLeftAt`：管理员房主断线时记下时刻；`onDisconnect` / `onHello` 维护它，
   `syncNoExpire`（房主换人）也跟着重置。
3. 管理员房的过期计时基准改成 `adminLeftAt`（人走了才开始走 15 分钟），
   而不是 `createdAt` —— 否则管理员人在的时候房间就可能被判过期。

**行为**：
| 情况 | 结果 |
|---|---|
| 管理员在线 | 房间永久保留（原来是这个行为，保持） |
| 管理员离线 < 15 分钟 | 保留（切窗口、重连都来得及） |
| 管理员离线 > 15 分钟 | **回收**（新增） |
| 管理员回来 | `adminLeftAt` 清零，恢复永久保留 |

**验证**：`node test\admin-room-reap.mjs` —— 4/4 通过（新增）。
`test\stuck-match-room.mjs` 里原本断言「管理员房即使没人也不回收」，按这次需求改成
「在线保留 / 离线回收」两条。

`patcher\check-features.mjs` 加了 `adminOwnerOnline` 的存在 + **必须被调用**两条断言 ——
只写函数不调用是常见的「假修复」，破坏性测试确认这种情况会 FAIL。

---

### 1e. 手机「画面质量」调到最高依然模糊

**现象**：玩家反馈手机上调到最高画质，画面依然很糊。

**病根**：`public/js/render/app.js` 里

```js
const dpr = () => Math.min(devicePixelRatio || 1, QUALITY_RES[settings.quality] || 2, lean ? 1 : 2);
const boardDpr = () => Math.min(devicePixelRatio || 1, BOARD_RES[settings.quality] || 2, lean ? 0.85 : 2);
```

`lean = touchDevice()`，也就是**只要是触屏设备，第三项恒为 1**，
`Math.min` 之后不管画质选什么都得到 1。手机 DPR 通常是 3，
夹到 1 等于只画了 1/9 的像素 —— 低/中/高在手机上**完全一样**，设置形同虚设。

讽刺的是旁边第 207–208 行的注释写着「an explicit 设置 choice must still change
resolution/particle load」，代码恰好违反了这句话。

**改了什么**：触屏像素上限改成**按画质分档**，不再一刀切：

```js
const TOUCH_DPR_CAP       = { high: 2,   medium: 1.5, low: 1 };      // 战斗画面
const TOUCH_BOARD_DPR_CAP = { high: 1.5, medium: 1.25, low: 0.85 };  // 3D 棋盘
```

| 画质 | 手机（DPR 3）改前 | 手机改后 | 桌面(D​PR 2) |
|---|---|---|---|
| 高 | 1 | **2** | 2 |
| 中 | 1 | **1.5** | 1.5 |
| 低 | 1 | 1 | 1 |

高画质给 2 而不是 3：2x 在手机上已经明显清晰，3x 的填充成本是 2x 的 2.25 倍，
散热顶不住。低画质保持 1，省电档位不受影响。**桌面端完全没变。**

**涉及文件**：`public/js/render/app.js`（静态文件，**刷新即生效，不用重启**）

**验证**：
```
node test\quality-mobile-dpr.mjs        全部通过（新增）
node test\e2e-mobile-quality-dpr.cjs    DPR3 + 触屏模拟下 high=2 / medium=1.5 / low=1
```
线上 `https://stronghold.luobomiao.love/js/render/app.js` 已确认含 `TOUCH_DPR_CAP`，
且 `cache-control: no-cache`，玩家刷新就能拿到。

`patcher\check-features.mjs` 新增 `client-mobile-quality`（4 条断言），
把高画质改回 1x 会让单测和校验器同时变红（破坏性测试已验证）。

---

### 1f. 部分敌人没有模型加载出来（显示成灰块）

**现象**：玩家截图里右上角的镰刀幽灵、右下角的黑影只渲染成灰色方块/黑块。

**病根**：`data/assets.json` 给这 6 个敌人声明了 `spineLocal`（本地素材），
但 `data/local-assets.json`（负责把文件名映射成 URL 的清单）**没有收录对应的 group**。
`localSpineEntry()` 拿不到 URL 就返回 `null`，`spineEntry()` 于是也返回 `null`。

而这 6 个敌人**恰好没有 web 模型**（`spine: null`，也没有 `spineAliasOf`），
所以本地素材是它们唯一的模型来源 —— 清单漏一条，就必然画灰块。

| 敌人 | web 模型 | spineLocal | 清单 group |
|---|---|---|---|
| enemy_1201_sfzhi | 无 | 有 | 缺 → 已补 |
| enemy_1249_lysdb | 无 | 有 | 缺 → 已补 |
| enemy_1254_lypa | 无 | 有 | 缺 → 已补 |
| enemy_1275_dwlock | 无 | 有 | 缺 → 已补 |
| enemy_1373_ltnhor_2 | 无 | 有 | 缺 → 已补 |
| enemy_1376_ltndru | 无 | 有 | 缺 → 已补 |
| enemy_9016_acstmr | 无 | **无** | 无（素材本身就没有，属正常缺） |

素材文件一直在 CDN 上（`HEAD` 全部 200），磁盘 `shared/assets/local/spine/enemy/<id>/`
里也齐全，纯粹是清单漏登记。

**改了什么**：给 `data/local-assets.json` 补了这 6 个 group（76 → 82）。
新增 `tools/fix-local-enemy-groups.mjs`（幂等，支持 `--check`）。

> ⚠️ **升级上游后必须重跑一次**
> `data/local-assets.json` 在 `.gitignore` 里（它由本机 `tools/local-extract` 生成，不进仓库），
> 所以这个修复**不会随 git 走**。合并上游后执行：
> ```
> node tools\fix-local-enemy-groups.mjs --check   # 看有没有缺
> node tools\fix-local-enemy-groups.mjs           # 补上
> node test\asset-manifest-gaps.mjs               # 确认全部可解析
> ```

**验证**：
```
node test\asset-manifest-gaps.mjs        全部通过（新增）
node test\e2e-enemy-model-load.cjs       6/6 可解析、模型文件全部 200（新增）
```
线上 `data/local-assets.json` 已确认 82 个 group、6/6 到位。

`patcher\check-features.mjs` 新增 `client-enemy-local-model`（6 条断言）。
注意这条检查的是 `data/local-assets.json`（被 gitignore），
所以它只在**本机运行时有意义** —— 上游合并后先跑修复工具再跑校验器。

---

### 1g. 某个干员一直只显示头像、没有模型

**现象**：战斗中一个干员位置上只有一个菱形头像框，同场其他干员模型都正常。

**排查**（先说结论：**不是素材缺失**）：
```
node test\op-model-gaps.mjs        229 个干员全部有 Front 模型
node test\skin-model-gaps.mjs      486 个皮肤模型全部有效
```
素材、皮肤、清单都是完整的。

**病根**：`render/units.js` 里模型加载失败后的重试是**有次数上限的**：

```js
if (!this.actor && this._spineTries < SPINE_RETRY_MS.length)   // ← 4 次后彻底放弃
  this._retryAt = nowMs() + SPINE_RETRY_MS[this._spineTries++];
```

`SPINE_RETRY_MS = [1200, 4000, 10000, 25000]`，合计约 40 秒。用完之后这个单位就**永久挂着菱形头像**，
只有两种情况能让它再试：素材清单发生变化（`assets.onChange`），或玩家**切走标签页再回来**
（`visibilitychange` → `retryAssets`）。

而 `retryAssets` 正是「重试耗尽后唯一的补救入口」—— 玩家一直盯着战斗画面不动，
就永远等不到那一次补救。多单位同时进场时个别请求超时/失败很常见，
于是表现为「就那一个干员没模型」，而且**怎么等都不会自己恢复**。

**改了什么**（`public/js/render/units.js`）：

- 前 4 档仍按 `SPINE_RETRY_MS` 快速重试（网络抖动几秒内就能恢复）；
- 用完转入**长期退避**：25s → 50s → 封顶 60s，**永不放弃**；
- 加载成功即清零，回到正常状态。

不会拖垮网络：封顶 60 秒，且只在模型确实缺失时才重试。

**验证**：
```
node test\model-retry-backoff.mjs   全部通过（新增）
```
覆盖：源码不再有「次数用尽就放弃」、失败后无条件安排重试、第 100 次仍会重试、
退避封顶 60s、60 秒内至少重试 5 次（旧实现 4 次后停止）。

`patcher\check-features.mjs` 新增 `client-op-model-retry`（4 条断言），
改回旧逻辑会让单测和校验器同时变红（破坏性测试已验证）。

**涉及文件**：`public/js/render/units.js`（静态文件，**刷新即生效，不用重启**）

---

### 1h. 某个干员模型 404（真正的原因：CDN 把 404 也缓存 30 天）

**抓到现场的经过**：让管理员在观战页开 DevTools → 网络，筛 `skel`，刷新后看到：

```
char_133_mm.skel   404   pixi.min.js    23 ms
char_133_mm.skel   404   sw.js?v=...    (disk cache)   0 ms
```

同一行两个 404，第二个来自 **disk cache**、耗时 **0 ms** —— 请求根本没发出去。
`char_133_mm` 就是「梅」（MAIN）。

**验证服务器上文件是好的**：
```
HEAD https://assets.luobomiao.love/assets/spine/op/char_133_mm/front/char_133_mm.skel  → 200
GET  同上（带 Origin/Referer）                                                          → 200, 96578 字节
抽检 12 个干员模型                                                                        → 12/12 = 200
```

**真正的病根**：
```
404 响应的头：cache-control: public, max-age=2592000, immutable
```

CDN（或它前面的 nginx）**对 404 也发了 30 天的 immutable 缓存头**。
`immutable` 的语义是「这个资源在有效期内绝不会变，不用再验证」——
所以某个模型只要**曾经** 404 过一次（比如某次发布过程中文件短暂缺失），
浏览器就会把「不存在」这个结论**缓存 30 天，且永不重新验证**。

这和之前修过的 nginx 缓存 404 是同一类问题，但发生在**浏览器端**，服务端改头已经来不及。

**改了什么**（`public/js/assets.js`）：

- 新增 `spineBust(entry, n)`：把 skel / atlas / textures 的 URL 都加上 `?r=<n>`。
- `RefLru.load` 的**重试路径**（`o.fresh`：失败后重试 / restart）传入 busted entry，
  让 URL 变掉 → 变成新的缓存键 → 真正回服务器拿文件。
- **首次加载仍用干净 URL**，正常命中 CDN 缓存，不影响性能。

配合 1g 的「重试永不放弃」，现在：模型一旦失败 → 1.2s 后重试（此时已带 bust）→ 拿到 200 → 显示出来。
**玩家不需要手动清缓存。**

> ⚠️ 服务端也建议一起修（本次未动，属基础设施）
> 让 nginx / CDN 对 4xx 不发 `immutable`，例如：
> `location ~ \.(skel|atlas|png|json)$ { add_header Cache-Control "public, max-age=2592000" always; }`
> 或对 error_page 单独设 `add_header Cache-Control "no-store" always;`。
> 否则**今后任何一次** 404 都会继续毒化 30 天缓存，只是现在有 self-heal 兜底。

**验证**：
```
node test\spine-cache-bust.mjs   全部通过（新增）
```
覆盖：skel/atlas/贴图都带 bust、每次重试值不同、不修改原 entry、
相对路径不强行改写、首次加载不加 bust、重试路径确实调用。
另实测 `?r=1` 的三个文件均 200。

`patcher\check-features.mjs` 新增 `client-spine-cache-bust`（3 条断言）。

**涉及文件**：`public/js/assets.js`（静态文件，**刷新即生效，不用重启**）

---

### 2. 隐身观战加载不出来

**病根**：`Lobby.sendToPlayer()` 只认 `seatOf()` / `spectatorOf()`，
而隐身观战者只存在于 `hiddenSpectators`，两者都查不到，
于是 `addSpectator → _resync` 的补发帧被直接 `return false` 丢掉，
对局屏永远停在「正在进入模拟…」。

第一版只修了广播路径（`memberSessions`），单测用假 Match 绕过了单播所以「全绿」，
真实进程一验就露馅。现在两处都修了。

**涉及文件**：`server/lobby.js`（`sendToPlayer` 加 `room.hiddenSpectatorOf(playerId)`）

**验证**：`node test\e2e-hidden-watch-live.mjs 3001` —— 真实进程 10/10 通过。

#### 2b. 隐身观战不能切换观战目标（玩家后续反馈）

**病根**：`Lobby.roomOf(session)` 只认 `seatOf()` / `spectatorOf()`，和上面的
`sendToPlayer()` 是同一个漏网之鱼。隐身观战者两者都查不到，于是
`session.roomCode` 被当成「无效」清成 `null` 并 `return null`，
`routeGameNow()` 直接回 `NOT_IN_ROOM`。

表现：观战画面永远停在进入时自动打开的 P1，点任何队友都没有反应。
（自动打开 P1 是 `game.js` 的 `autoP1Ref`，只跑一次；因为它只设了本地
`watching`，本地看着像「已经切过去了」，实际服务端一次都没收到成功的 `g.watch`。）

**顺带补的一个口子**：`routeGameNow()` 里「观战者只能 watch」这道拦截只判了
`room.spectatorOf()`，隐身观战者的其它 `g.*` 会被直接转发给对局，等于能替玩家操作。
现在改成 `room.watcherOf()`（= 普通观战席 + 隐身观战席）。

**涉及文件**：`server/lobby.js`（`roomOf` 加 `hiddenSpectatorOf` 分支；
`routeGameNow` 的 SPECTATOR 拦截改用 `watcherOf`）

**验证**：`node test\e2e-hidden-watch-switch.mjs 3001` ——
真实进程上依次 `g.watch` 到 3 个不同玩家，全部收到对应的 `m.field`（3/3）。

`patcher\check-features.mjs`（`client-room-spectator`）已加两条断言，
故意删掉那行修复会 FAIL（破坏性测试已验证），避免以后升级再丢。

---

### 3. 游客会接任房主（匹配流程实测时发现）

**问题**：房间里是「注册房主 + 游客」时，房主退出后**房主会落到游客头上**
（日志标记 `all guests, fallback`）。

原意是「避免房间无主卡住」，但代价是游客拿到了房主权限——开始对局、调整实验选项、
踢人、解散房间全都只判 `room.hostId !== session.playerId`，游客一旦是房主就都能做。
这违背「游客只能游玩和旁观」。

而且「无主房间」本来不会卡：房里已经没有任何注册玩家，直接解散才是对的。

**修改**（`server/lobby.js`）：
- `migrateHost`：只在非游客里挑房主；只剩游客时房主置空，不再退回给游客
- `removeMember` / `dropStaleAccountSeats`：判空条件从 `activeHumans().length === 0`
  改成「没有非游客」，只剩游客也解散

**匹配其他路径已确认无问题**：
- 游客不能建房 → 不可能成为匹配主房间
- 组队池主房间 `filter(!guest)`
- 单人池房主 `find(!guest)`
- 主房间离线时新建房间，不把游客房当主

**验证**：`node test\matchmaking-guest-host.mjs`、`node test\guest-cannot-host.mjs`（7/7）

---

## 二、匹配功能实测结论

匹配机制本身**验证过是正常的**，14+ 组断言全过：

| 项目 | 结果 |
|---|---|
| 凑满人数才成局 | ✅ 4 个房凑满自动成局 |
| 主房间 = 人数最多的队 | ✅ 实测返回 `home:true` 的是最早排队那个，其余 `home:false` 加入 |
| 不同难度 / 人数 / 版本不进同一池 | ✅ |
| 匹配完成后自动准备 + 自动开始 | ✅ 非房主自动 ready，房主全员就绪且满员时 start |
| 有人掉队不会卡死 | ✅ 30 秒后按已到人数开始 |
| 只踢真正断线的 | ✅ 加载中的玩家不踢 |
| 游客不当房主 | ⚠️ **本次修好**（见上面第 3 条） |
| 队列 TTL 与上限保护 | ✅ |

**一个现状提醒**：所有节点的 `SP_EXPERIMENTAL` 都**没有设置**，
所以 5–20 人实验房默认是关闭的，匹配池里目前只有默认 4 人房。
如果 5–20 人房要开放匹配，需要先给节点加上 `SP_EXPERIMENTAL=1`。

---

## 二、重启时一定要注意的坑

### ⚠️ `pm2 restart` 不会重新读 ecosystem.config.cjs

`pm2 dump.pm2` 里存的是**旧值 1**：

```
ecosystem.config.cjs : SP_MAX_ROOMS_PER_ADDR = 3   ← 新值
pm2 dump.pm2         : SP_MAX_ROOMS_PER_ADDR = 1   ← 旧值，重启会沿用这个
```

所以重启**必须带 `--update-env`**，否则环境变量还是 1，建房修复等于没生效：

```powershell
# 正确
pm2 restart node-1 --update-env

# 或者整批（推荐，会重新读 ecosystem）
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save          # ★ 别忘了，把新环境变量写回 dump
```

重启后**务必核对**：

```powershell
$d = Get-Content "$env:USERPROFILE\.pm2\dump.pm2" -Raw | ConvertFrom-Json -AsHashtable
($d | Where-Object { $_.name -eq 'node-1' }).env['SP_MAX_ROOMS_PER_ADDR']
# 应该输出 3，不是 1
```

### ⚠️ 静态文件必须 30 个节点一起更新

nginx 会把 `/js/*.js`、`/css/*.css` 轮询分发到 30 个节点。
只改 `node-1` 时，浏览器有一大半概率拿到其他节点的旧文件，
表现为「改了但没效果」——这次会话已经踩过两次。

### ⚠️ 重启前确认没有活跃对局

```powershell
foreach ($n in 1..30) {
  try {
    $j = (Invoke-WebRequest -Uri "http://127.0.0.1:$(3000+$n)/healthz" -UseBasicParsing -TimeoutSec 4).Content | ConvertFrom-Json
    if ($j.rooms -gt 0) { "node-$n rooms=$($j.rooms) matches=$($j.matches) humans=$($j.humans)" }
  } catch {}
}
```

---

## 三、重启后要验证的

```powershell
# 1. 环境变量是新的
($d | Where-Object { $_.name -eq 'node-1' }).env['SP_MAX_ROOMS_PER_ADDR']   # = 3

# 2. 功能自检
node patcher\check-features.mjs

# 3. 回归测试
node test\room-limit-scenarios.mjs
node test\room-limit-three.mjs
node test\e2e-hidden-watch-live.mjs 3001

# 4. 30 节点健康
foreach ($n in 1..30) { try { (Invoke-WebRequest -Uri "http://127.0.0.1:$(3000+$n)/healthz" -UseBasicParsing -TimeoutSec 4).StatusCode } catch { "node-$n FAIL" } }
```

---

## 四、已经生效的（不用管）

这些是纯客户端文件，nginx 直接发，刷新页面即可：

- **对局中节点状态胶囊**（`matchmaker/public/client.js`，`Cache-Control: no-store`）
  - 外框不见了 → 外框改画在 `.chip` 上（真正被看见的那一层），带 `var(--line)` 兜底
  - 遮挡按钮 → 新增 `.gtop` 专用分支：只把药丸放进 `.gtop__net`，
    **不再把父容器改成 `display:flex; gap:10px`**（之前这一改把难度标签
    「维多利亚 正常」挤到右边、压住「回合」进度条），同时清掉 `z-index:46` 残留
  - 预览：`dist/_shot-chip-preview.png`
- **素材下载不再重复请求**（改 Cache Storage 记录；重新打开 0 个请求）
- **玩家清缓存后仍能重新下载**（已验证）
- **表情弹幕**（5–20 人房）
- **观战席上限随人数动态变化**
- **大厅卡片等高、实验弹窗布局**
- **5–20 人房建房入口**（大厅「同盟人数」下拉，刷新即见）
- **「一直刷新都不能好」**（boot.js 重试计数启动成功即清零，支持 `?boot=1`）

---

## 五、重启后的收尾

重启并验证通过后，请：

1. 把本文件的「状态」改成已生效，或直接删掉第一部分
2. 如果之后还有新的待生效改动，追加到第一部分
3. **维护开关**：目前 `content/game-gate.json` 与各节点 `create-room.json` 仍是开启状态，
   正式开放前要决定是否关回

---

## 2026-10-26 17:05 nginx 分流同步：新玩家不再登录进受限节点

### 问题

MM_DISABLED_NODES 只管匹配器「挑哪个节点」，管不到**新玩家首次访问**：
nginx 的 split_clients 是静态权重表，会把访客随机分到 1-30 全部节点，
包括正在维护的那些。玩家 cookie 里的 sp_route 同样会把已访问过的人粘回去。

### 改了什么（nginx/conf/nginx.conf）

1. split_clients \ 只保留开放的 12 个节点（2,4,5,6,7,8,15,21,22,24,26,30），
   权重按 12 等分。
2. 新增 map \ \：cookie 指向开放节点记 1，指向维护节点记 0。
3. location / 的优先级（后面的 if 覆盖前面的）：
   - cookie 指向开放节点 -> 粘住
   - ?room=CODE / n= / adminWatch=1 -> 强制回原节点（正在玩的人不受影响）

### 实测

- sp_route=1/3/9/10/13/19/20/23/29（全受限）：全部重新分流到开放节点
- sp_route=2/5/22/30（开放）：全部粘住原节点
- ?n=20 且 cookie=2：仍回 node-20，房间上下文优先

> 可开放节点变了要改两处：ecosystem.config.cjs 的 MM_DISABLED_NODES
> 和 nginx/conf/nginx.conf 的 split_clients + \ 映射表。
> nginx 那份不在 git 仓库里（本机运维配置），改完执行 nginx -t 然后 -s reload。

---

## 2026-10-26 17:16 对外开放只改 nginx

MM_DISABLED_NODES 已从 `ecosystem.config.cjs` 移除（匹配器进程里也没了这个变量）。
现在**哪 17 个节点对外开放，只由 nginx 的 `split_clients` + `` 决定**。

当前开放（17）：1,2,4,5,6,7,8,10,15,20,21,22,24,25,26,28,30

> 清空环境变量有个坑：`pm2 restart --update-env` **不会**清掉已存在的变量，
> 必须 `pm2 delete matchmaker` 再 `pm2 start ecosystem.config.cjs --only matchmaker`。

同时修了观战的两个问题（`mm/client.js`）：
1. `JOIN_COOKIE` 分支写死 `false`，观战会退化成加入 —— 现在观战意图进 `mm.pendingRoom`
2. `joinFlow` 只比房间号，自己在同房间当玩家时点观战会被当成「已加入」而不发 `room.spectate`
   —— 现在观战还要求「自己在该房间的观战席上」
