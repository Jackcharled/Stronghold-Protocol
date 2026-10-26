# 待生效改动与重启清单

最后更新：2026-10-26 12:45
状态：**等待重启**（服主安排时间，不要自行重启）

---

## 一、已改好、已推 GitHub、已同步 30 节点，但还没生效

这些改动在磁盘上都已就位，只是进程还在跑旧代码，**必须重启才生效**。

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

### 2. 隐身观战加载不出来

**病根**：`Lobby.sendToPlayer()` 只认 `seatOf()` / `spectatorOf()`，
而隐身观战者只存在于 `hiddenSpectators`，两者都查不到，
于是 `addSpectator → _resync` 的补发帧被直接 `return false` 丢掉，
对局屏永远停在「正在进入模拟…」。

第一版只修了广播路径（`memberSessions`），单测用假 Match 绕过了单播所以「全绿」，
真实进程一验就露馅。现在两处都修了。

**涉及文件**：`server/lobby.js`（`sendToPlayer` 加 `room.hiddenSpectatorOf(playerId)`）

**验证**：`node test\e2e-hidden-watch-live.mjs 3001` —— 真实进程 10/10 通过。

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

- **素材下载不再重复请求**（改 Cache Storage 记录；重新打开 0 个请求）
- **玩家清缓存后仍能重新下载**（已验证）
- **表情弹幕**（5–20 人房）
- **观战席上限随人数动态变化**
- **大厅卡片等高、实验弹窗布局**

---

## 五、重启后的收尾

重启并验证通过后，请：

1. 把本文件的「状态」改成已生效，或直接删掉第一部分
2. 如果之后还有新的待生效改动，追加到第一部分
3. **维护开关**：目前 `content/game-gate.json` 与各节点 `create-room.json` 仍是开启状态，
   正式开放前要决定是否关回
