# 待生效改动与重启清单

最后更新：2026-10-26 13:20
状态：**已部分重启**（2026-10-26 13:15，只重启了无连接节点）

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
