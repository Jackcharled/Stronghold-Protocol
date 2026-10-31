# 卫戍协议 · 运维维护手册（2026-10-26）

> 新会话接手必读。本文件覆盖：整体架构、30 节点、管理后台、数据库、控制台、日常运维、故障排查，
> 以及**更新 GitHub 前的必查清单**（第九章）。
> 配套文档：[AGENTS.md](AGENTS.md)（AI 助手入口 + 硬性规则）、[patcher/README.md](patcher/README.md)（补丁体系）、
> [patcher/REPO-SYNC.md](patcher/REPO-SYNC.md)（仓库与运行目录的同步关系）、
> [PENDING-RESTART.md](PENDING-RESTART.md)（待重启记录）。

---

## 一、整体架构

```
玩家浏览器
   │  HTTPS
   ▼
nginx 1.31.7（D:\Stronghold-Protocol\nginx，443）
   ├── /              → 游戏静态页 + 注入脚本（/mm/client.js、/mm/account-title.js）
   ├── /js/**         → 按 sp_route cookie 路由到 node-1..30（首次访问随机分配）
   ├── /assets/**     → 已改为外部素材服务器（assets.luobomiao.love）
   ├── /mm/**         → matchmaker 127.0.0.1:3090（账号、同步、后台、公告、日志）
   ├── /mm/admin.html → 管理后台（需游戏登录态 + 邮箱验证码）
   └── /ws            → 按 sp_route cookie 转发到 30 个游戏节点之一
                          │
                          ▼
              node-1 … node-30（端口 3001–3030）
              每个节点：房间、对局、WS、持久化
                          ▲
                          │ 注册/负载/分配
                    matchmaker 3090
                          ▲
                          │ 读状态、重启
                    dashboard 3080（运维控制台）
```

### 核心进程（PM2）

| 进程名 | 端口 | 作用 |
|---|---|---|
| `matchmaker` | 3090 | 账号、云端存档、管理后台 API、公告、匹配服务、节点状态聚合 |
| `dashboard` | 3080 | 运维控制台（节点卡片、指标趋势、公告板、建房开关、房间时长） |
| `node-1` … `node-30` | 3001–3030 | 游戏节点：WS、房间、对局、持久化 |

启动方式：`pm2 start ecosystem.config.cjs`；保存：`pm2 save`。

---

## 二、30 个节点

| 项目 | 说明 |
|---|---|
| 数量 | 30，PM2 名 `node-N` |
| 端口 | `3000 + N`（node-1=3001 … node-30=3030） |
| 目录 | `D:\Stronghold-Protocol\node-N`（`node-1` 是基线，其余内容一致） |
| 健康检查 | `GET http://127.0.0.1:300N/healthz` → `{ sockets, sessions, rooms, matches, humans, bots, spectators }` |
| 持久化 | 每个节点用独立 Redis 前缀 `sp:n<N>:` 保存房间/会话/对局检查点，每 10 秒一次；建房（`room.create`）与开局（`startMatch`）时立即 flush 一次，重启后恢复（日志 `[persist] restored N session(s), M room(s)`） |
| 检查点 | 每 10 秒 |
| 单节点容量 | 房间上限与每 IP 限制写在 `server/http/config.js` 的 `LOBBY_OPTION_KEYS` |
| 节点分配 | 三条入口：①新玩家首次访问由 nginx 的 `split_clients $sp_rand_node` 随机分配；②匹配服务按负载选择节点；③之后都靠 `sp_route` cookie 粘住（`sp_node` 供前端读取，pin 时两个 cookie 一起写）。维护期要**同时**限制 ① 和 ②，见「重启窗口期」一节 |
| 重启影响 | 该节点上玩家掉线 1~2 秒自动重连，房间与对局由持久化恢复 |

### 节点常用命令

```powershell
pm2 list                          # 全部进程状态
pm2 logs node-1 --lines 50        # 看某节点日志
pm2 restart node-7 --update-env   # 重启单个节点
pm2 restart node-1; 1..30 | % { pm2 restart "node-$_" }   # 全量（慎用）
curl http://127.0.0.1:3007/healthz
```

### 节点配置项（环境变量）

| 变量 | 作用 |
|---|---|
| `SP_NODE_DIR` | 节点目录（用于识别 node-N） |
| `PORT` | 监听端口 |
| `SP_MAX_BOTS_PER_ADDR` | 单 IP 最多 AI 数 |
| `SP_IDLE_KICK_MS` | **已废弃**（挂机踢人已从代码移除，设置无效） |

### 匹配器配置项（`matchmaker`，在 `ecosystem.config.cjs` 的 `matchmaker.env`）

| 变量 | 作用 |
|---|---|
| `MM_PORT` / `MM_HOST` | 匹配服务监听地址（3090 / 127.0.0.1） |
| `MM_EXPERIMENTAL_NODE` | 5–20 人大厅专用节点，默认 `4`。**这个节点必须在 nginx 的开放列表里**，否则多人大厅开不出来 |
| `MM_DISABLED_NODES` | **通常不设**。哪些节点对外开放统一由 nginx 决定，见下节 |

### 对外开放哪些节点：只改 nginx

**规则：节点开放与否，只由 `nginx/conf/nginx.conf` 决定，不要动 `MM_DISABLED_NODES`。**

理由：能进来的玩家本来就只会落在 nginx 放行的节点上，匹配器即使把新对局分到
别的节点，也没有玩家能到那里。少一处要同步的配置，就少一次「改了 A 忘了 B」。

nginx 里要改的只有三处（都在 `http` 块和 `location /` 里）：

| 位置 | 作用 |
|---|---|
| `split_clients "$request_id" $sp_rand_node { … }` | 新玩家首次访问被随机分到这些节点，权重按数量等分 |
| `map $cookie_sp_route $sp_cookie_open { … }` | cookie 指向的节点是否开放：开放记 `1`，受限记 `0` |
| `location /` 里的四条 `if` | 真正决定落到哪台（见下） |

`tools\_set-open-nodes.mjs` 会**同时**改前两处，两份列表不会不同步 —— 不要手动只改一处。

#### `location /` 的分流规则（2026-10-28 定稿，照这个思路操作）

维护者原话：「虽然玩家可以通过观战代码和房间码进入到这些节点，但是新玩家的登录默认
不往这些已经关闭对外的节点发。」

```
if ($sp_cookie_open = 0) { set $sp_node $sp_rand_node; }   # ① cookie 指向受限节点 → 改派
if ($sp_cookie_open = 1) { set $sp_node $cookie_sp_route; } # ② 只粘「开放」节点的 cookie
if ($arg_room ~ "^[A-Za-z0-9]{4,6}$") { … }                 # ③ 房间码 → 回原节点
if ($sp_room_node) { … }                                    # ③ ?n=
if ($arg_adminWatch = 1) { … }                              # ③ 观战
```

nginx 的 `if` **按书写顺序执行，后面的覆盖前面的**，所以顺序不能改：

| 场景 | 落点 | 结果 |
|---|---|---|
| 新玩家，没有 cookie | `$sp_rand_node` | 随机到开放节点 |
| 老玩家，cookie 指向**开放**节点，打开首页 | cookie 的节点 | 粘住（体验不变） |
| 老玩家，cookie 指向**受限**节点，打开首页 | `$sp_rand_node` | **改派到开放节点**（2026-10-28 新增） |
| cookie 指向受限节点 + `?room=CODE` | cookie 的节点 | **回原节点**，正在玩的对局不受影响 |
| cookie 指向受限节点 + `?n=N` / 观战码 | 指定节点 | **能进受限节点** |
| 已连着受限节点的玩家 | — | 本次请求不走这里，**不断线** |

**踩过的坑（两次，都记下来免得再来一次）**：

1. **2026-10-20 之前**：这里曾是无条件的 `if ($sp_cookie_open = 0) { set $sp_node $sp_rand_node; }`。
   它把「正在旧节点上打对局、只是刷新了页面」的人也一起改派走，
   服务端找不到房间 →「**回不到对局**」。整个改派因此被移除。
2. **2026-10-28 第一次修复没生效**：写成

   ```nginx
   if ($sp_cookie_open = 0) { set $sp_node $sp_rand_node; }
   if ($cookie_sp_route ~ "^([1-9]|[12][0-9]|30)$") { set $sp_node $cookie_sp_route; }   # ← 又改回去了
   ```

   第二条对**任何**合法 cookie 都成立，把刚做的改派覆盖掉。
   正确写法是给「粘住」加条件：`if ($sp_cookie_open = 1) { … }`。

**改完的验证**（必须两个方向都测，只测一个会漏掉上面第 2 个坑）：

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'
# A) 受限节点的 cookie + 首页 → 必须被改派（连做 10 次，一次都不该落到受限节点）
1..10 | ForEach-Object {
  (Invoke-WebRequest 'https://127.0.0.1/' -UseBasicParsing -SkipCertificateCheck `
    -Headers @{cookie='sp_route=1'}).Headers['X-SP-Node']
}
# B) 同一个 cookie + ?room= → 必须回到原节点（老玩家回房间）
(Invoke-WebRequest 'https://127.0.0.1/?room=ABCD' -UseBasicParsing -SkipCertificateCheck `
  -Headers @{cookie='sp_route=1'}).Headers['X-SP-Node']
```

**改完必须 `nginx -t` 校验 + 重启生效**。⚠ 以 SYSTEM 身份运行的 nginx **不接受**普通管理员的
`-s reload`（`OpenEvent ... Access is denied`），要用 `node tools\restart-nginx.mjs --apply`
（它会先清干净再经计划任务重启）；**不要**直接在终端 `-s quit`/`-s reload`，
今天就是这么把 worker 越堆越多的。

**为什么受限节点上还有房间是正常的**：`sp_route` 的作用是让浏览器粘住它所属的节点。
节点被摘出开放列表**不代表**上面的人要立刻走 —— 他们的对局还在，重连必须回得去。
摘列表只影响「打开首页」这一步。2026-10-28 看到 node-1 已关闭却仍有 7 间房，
原因就是这些玩家的 cookie 还指向 node-1；新规则生效后他们**这局还能打完**，
但关掉页面重新打开会落到开放节点。

> `MM_DISABLED_NODES` 只在临时需要「不让匹配器往某节点分发」时才用
> （比如该节点磁盘满了），用完记得清空；清空后要 `pm2 delete matchmaker`
> 再 `pm2 start ecosystem.config.cjs --only matchmaker`，因为
> `pm2 restart --update-env` 不会清掉已存在的环境变量。

### 重启窗口期：节点分批维护的标准做法

节点上有人在对局时**不能重启**。要更新服务端代码又不想打断玩家，按这个顺序做：

**第一步：判断哪些节点能重启**

```powershell
foreach ($n in 1..30) {
  $j = Invoke-RestMethod "http://127.0.0.1:$((3000+$n))/healthz" -TimeoutSec 2
  if ($j.rooms -eq 0 -and $j.matches -eq 0 -and $j.humans -eq 0) { "node-$n 空闲" }
}
```

判断标准是 `rooms / matches / humans` **全为 0**，不能只看 `uptimeSec`。
`sockets > 0` 但 `humans = 0` 通常是节点自己到 127.0.0.1 的内部连接，不算玩家。
重启前**再查一次**（两次采样），避免刚好有人进来。

**第二步：重启空闲节点，并把它设为开放**

```powershell
pm2 startOrReload ecosystem.config.cjs --only node-7 --update-env
pm2 save
```

> 必须用 `startOrReload ... --update-env` 才会重读 `ecosystem.config.cjs`；
> 普通 `pm2 restart` 不会重读，环境变量还是旧的。

**第三步：把有玩家的节点从 nginx 的开放列表里摘掉**

只改 `nginx/conf/nginx.conf`（三处，见上一节「对外开放哪些节点：只改 nginx」）：

| 位置 | 改什么 |
|---|---|
| `split_clients $sp_rand_node` | 只保留开放节点，权重按数量等分 |
| `map $cookie_sp_route $sp_cookie_open` | 受限节点记 `0`，开放节点记 `1` |

```powershell
.\nginx\nginx.exe -t -c "$PWD\nginx\conf\nginx.conf" -p "$PWD\nginx"
.\nginx\nginx.exe -s reload -c "$PWD\nginx\conf\nginx.conf" -p "$PWD\nginx"
```

> **不需要改 `MM_DISABLED_NODES`。** 匹配器分到哪台机器，玩家也到不了没开放的节点。

**这些限制拦的是什么、不拦什么**

| 场景 | 受限节点 |
|---|---|
| 新玩家首次访问被 nginx 随机分配进来 | ❌ 不会（`split_clients` 里没有它） |
| 匹配系统把新玩家分进来 | ❌ 不会（`DISABLED_NODES` 排除） |
| 旧 `sp_route` cookie 指向它，**打开首页** | ❌ 会被改派到开放节点（2026-10-28 起） |
| 旧 `sp_route` cookie + **`?room=CODE` 回房间** | ✅ **回原节点**，正在玩的对局不受影响 |
| **房间里已有的玩家继续游玩** | ✅ **完全不受影响** |
| **房间直连**（`?room=CODE`、`n=`、`adminWatch=1`） | ✅ **强制回原节点，绝不切走** |
| 打完后在房间里再开一局 | ✅ 可以 |

**第四步：等对局自然结束后，重复第一步**，把空出来的节点重启、加回开放列表。

**验证是否真的生效**

```powershell
# 匹配器启动日志应打印
Get-Content logs\matchmaker.out-*.log -Tail 5 | Select-String "暂停接收新玩家"

# A) 带受限节点 cookie 打开首页 → 必须被改派（多试几次，一次都不该落到 20）
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'
1..10 | ForEach-Object {
  (Invoke-WebRequest "https://127.0.0.1/" -UseBasicParsing -SkipCertificateCheck `
    -Headers @{ Cookie = "sp_route=20" }).Headers['X-SP-Node']      # 不应出现 20
}

# B) 房间直连必须仍回原节点（老玩家回房间）
(Invoke-WebRequest "https://127.0.0.1/?n=20" -UseBasicParsing -SkipCertificateCheck `
  -Headers @{ Cookie = "sp_route=2" }).Headers['X-SP-Node']          # 必须是 20
```

> 两条都要测。只测 B 会漏掉「改派被下一条 `if` 覆盖」的坑（§9.x `location /` 分流规则）。

**第五步：全部节点更新完**，把 nginx 的 `split_clients` 恢复成 30 个节点各 3.33%、`$sp_cookie_open` 全部记 `1`，
再 `nginx -t` 校验 + **`node tools\restart-nginx.mjs --apply`** 生效。

> ⚠ 不要用 `nginx.exe -s reload`：以 SYSTEM 身份运行的 nginx 不接受普通管理员的信号
> （`OpenEvent ... Access is denied`），而且 reload 会留下不退出旧 worker，越堆越多。

> 当前进度与每次的节点清单记录在仓库根目录 `PENDING-RESTART.md`。

#### ⚠ 「哪些节点已更新」不能只看 `lobby.js`（2026-10-27 踩过）

`tools\_restart-when-idle.ps1` 判断「进程是否跑着新代码」用的是
**`node-N/server/lobby.js` 的 mtime**。这只在改动正好落在 `lobby.js` 时成立。

那天改的是 `server/sim/content/bands/meta.js`（鸭爵补抽），结果脚本报
「已载入新代码: 30 / 30」，**实际 30 个节点全是旧的**（进程 15:36 启动，
`meta.js` 16:30 才改）。差点据此以为不用重启。

**正确做法：拿本次真正改过的文件的 mtime 去比**，而不是固定某一个文件：

```powershell
# 改成你这次动过的那个文件
$mt = (Get-Item 'repo-sync\server\sim\content\bands\meta.js').LastWriteTime
$now = Get-Date
foreach ($n in 1..30) {
  $h = Invoke-RestMethod "http://127.0.0.1:$((3000+$n))/healthz" -TimeoutSec 3
  $started = $now.AddSeconds(-[double]$h.uptimeSec)
  if ($started -lt $mt) { "node-$n 还没加载新代码  matches=$($h.matches)" }
}
```

更稳的做法是直接比 **`server/` 目录下最新的 mtime**（`_restart-stale.ps1` 就是这么做）：

```powershell
$mt = (Get-ChildItem node-1\server -Recurse -File -Include *.js | Measure-Object LastWriteTime -Maximum).Maximum
```

#### ⚠ 重启后必须同步改开放列表，否则新玩家仍然会进旧代码节点

`matches = 0` 只说明「这个节点现在可以安全重启」，不代表它「已经更新」。
重启完要把**还没重启的节点从 nginx 开放列表里摘掉**，否则 `split_clients`
仍会把新玩家随机分到那些跑着旧代码的节点上，表现为「改了但玩家没看到效果」。

| 状态 | nginx `split_clients` | `$sp_cookie_open` |
|---|---|---|
| 已重启、跑新代码 | 保留 | `1` |
| 有对局、还没重启 | **移除** | `0` |

**正在对局的玩家不受影响**：`sp_route` cookie 对开放列表是无关的，
带房间上下文的请求（`?room=` / `n=` / `adminWatch=1`）也强制回原节点。
受限只影响「新来的玩家首次落点」。

工具：`tools\_set-open-nodes.ps1`（只改 nginx，自动校验百分比合计 = 100%），
改完 `nginx -t` + `-s reload`。

#### ⚠ 改 nginx.conf 的编码陷阱：加 BOM 会让 nginx 直接起不来（2026-10-27 踩过）

`tools\_set-open-nodes.ps1` 用 `Set-Content -Encoding UTF8` 写文件 —— 在 **Windows PowerShell 5.1**
下这个参数会**加 BOM**，nginx 把第一行读成 `\ufeffworker_processes`，报：

```
nginx: [emerg] unknown directive "﻿worker_processes" ... :1
```

同时它读原文件的编码也不稳，实测把中文注释读成乱码（`鍏朵綰`）再写回去。

**服务当时没断**，因为 nginx 跑的是内存里的旧配置 —— **但下次 reload 一定炸**。这是最危险的那种坏：
文件坏了、服务看着好、直到下次重启。

**正确做法：用 `tools\_set-open-nodes.mjs`**（Node 读写，天然 UTF-8 无 BOM，写前校验、写后 `nginx -t`、
失败自动还原）：

```powershell
node tools\_set-open-nodes.mjs 2,4,7,12,13,14,16,18,20,21,24,25,27,30
```

它输出的最后两行必须是这样：

```
BOM: 无 ✓   中文完好: ✓
nginx 已 reload
```

（`tools\_set-open-nodes.ps1` 保留作参考，但在 PowerShell 5.1 下不要用。）

**任何脚本改完 nginx.conf 后都检查这三个**：

```powershell
$b = [System.IO.File]::ReadAllBytes('nginx\conf\nginx.conf')
"BOM: $(if($b[0] -eq 0xEF){'有 ✗'}else{'无 ✓'})"
(Get-Content nginx\conf\nginx.conf -TotalCount 1)      # 中文不能是乱码
.\nginx\nginx.exe -p "$PWD\nginx" -c conf/nginx.conf -t # 必须 successful
```

**改前一定要备份**（`_set-open-nodes.mjs` 失败会自己还原，手工改的时候就得靠自己）：

```powershell
Copy-Item nginx\conf\nginx.conf "nginx\conf\nginx.conf.bak-$(Get-Date -Format 'MMdd-HHmmss')"
```

#### 🔍 玩家说「素材/地图没加载出来」怎么查（2026-10-27 新增）

`/assets/` 由 nginx **直接读磁盘**（`root shared/`），**不经过游戏节点** —— 所以
「某个节点重启过」和「地图加载不出来」没有因果关系，别往那个方向查。

以前这两个 location 都是 `access_log off`，资源请求完全不进日志，**根本无从判断**
是哪个文件失败。2026-10-27 起新增独立日志：

```
nginx/logs/assets.log
```

格式（**304 已被过滤掉**，只留真实传输和失败）：

```
2026-10-27T17:09:58+08:00 200 6544564B 0.000s src=-    uri=/assets/local/scene/act2autochess_m01/scene.bin
2026-10-27T17:09:58+08:00 404 0B       0.086s src=MISS uri=/assets/xxx.png
```

| 字段 | 含义 |
|---|---|
| `src=` 空 | 直接读本地磁盘（正常，最快） |
| `src=MISS` | 本地没有，回源取到并缓存（正常，略慢） |
| `src=HIT` | 命中 nginx 缓存（正常） |
| `status 4xx/5xx` | **失败**，重点看 |

**常用查法**：

```powershell
# 只看失败的
Get-Content nginx\logs\assets.log | Select-String ' (4\d\d|5\d\d) '

# 只看地图/场景资源
Get-Content nginx\logs\assets.log | Select-String 'local/scene'

# 看最慢的资源
Get-Content nginx\logs\assets.log | ForEach-Object { if ($_ -match ' (\d+\.\d+)s ') { [pscustomobject]@{ t=[double]$matches[1]; l=$_ } } } |
  Sort-Object t -Descending | Select-Object -First 20 -ExpandProperty l
```

⚠ **这是临时排查工具，高峰期约 300–400 MB/天**（一个玩家进一局要拉几百个素材，
其中 `assets/local`（场景）占约 70%）。排查完记得关掉：

```powershell
# 改成 access_log off;（两处：location /assets/ 和 location @assets_origin）
```

也可以随时清空：`Clear-Content nginx\logs\assets.log`

#### 🚫 nginx 也绝不能挂在你的进程/会话上（2026-10-27 维护者要求）

> 维护者原话：「确保你要是操作 Nginx 不会让他的进程挂载在你的进程上」

**nginx 和 pm2 是同一个道理**：进程的父进程链如果挂在某个交互式会话（终端 / AI 助手 / 桌面 shell）下，
那个应用一重启，nginx 就可能被一起带走 —— 全站立刻 502。

**实测发现的历史问题**（2026-10-27）：

```
pid=16740  session=2   master（10-25 14:59 启动）  ⚠ 不在 Session 0
pid=9024   session=2   worker（10-27 04:05 启动）  ⚠ 不在 Session 0
... 全部 8 个进程 session 都是 2（桌面会话）
```

对比 pm2（由 `SP-PM2-Resurrect` 以 SYSTEM 启动）：`SessionId = 0` ✓。

说明 nginx 当初**是从交互式会话启动的**，不是计划任务。虽然父进程已退出（暂时还活着），
但这属于随时可能出事的定时炸弹。

**正确做法**：

| 操作 | 必须这样做 |
|---|---|
| 启动 nginx | `schtasks /Run /TN "SP-Nginx-Start"`（SYSTEM + ServiceAccount） |
| 重启 nginx | `node tools/restart-nginx.mjs --apply`（内部也走计划任务） |
| **禁止** | 在终端 / AI 助手 shell 里直接 `nginx.exe` 或 `Start-Process nginx.exe` |

`tools/restart-nginx.mjs` 做的事（**2026-10-27 重写，顺序不能改**）：
1. 列出所有 nginx 进程及其 `SessionId`，标出不在 Session 0 的、标出超出 `worker_processes+1` 的残留
2. 统计当前对局数（提醒会影响多少玩家）
3. `-s quit` 优雅停止（给正在传输的请求收尾的机会）
4. **确认进程归零；没退的强制 `Kill()`** —— 不归零就中止，**绝不带着残留去启动**
5. **确认 443 已释放**
6. 用 `schtasks /Run /TN "SP-Nginx-Start"` 启动 → 新进程必然在 Session 0
7. 校验：进程数 ≤ 3、全部 `session=0`、HTTPS 200、**素材加载速度**

#### ✅ 2026-10-29 实测：正常重启是「零中断」的

这次是维护者自己在控制台点的重启（改了 `client.js?v=`，不重启不生效）。我做了一次
**每 3 秒探测一次**的监控，结果值得记下来当作「正常长什么样」的基线：

```
20:51:26  进程=3  HTTP=200  版本=20261026-107     ← 重启前
20:51:29  进程=5  HTTP=200  版本=20261029-1       ← 新 worker 起好，版本切换
```

**全程没有一次 HTTP 失败。**

关键就在于新旧 worker 的重叠：新 worker 起来（3→5）→ 旧 worker 退场（5→3）。
中间那 5 个进程是**正常现象**，不是残留；配合 `worker_shutdown_timeout 5m`（§9.17），
旧 worker 会在 5 分钟内自己退干净。

**玩家侧的真实影响**（对照表）：

| 指标 | 重启前 | 重启后 | 说明 |
|---|---|---|---|
| 对局 | 24 场 | **26 场** | 一场没断，期间还在涨 |
| 在线 | 77 人 | **85 人** | 同上 |
| 节点 | 30/30 | 30/30 | 节点进程完全没被碰 |

所以「重启 nginx 会中断 5–20 秒」这个说法**偏保守** —— 那是 `restart-nginx.mjs`
（先 quit 再 start，中间真有一段空窗）的情形；控制台/维护者手动重启走的是
新旧 worker 重叠的路子，玩家基本无感。

**判断重启是否真的成功，看这两条**：

```powershell
# 1) 版本号变了（改了 sub_filter 里的 ?v= 就必须确认这条）
(Invoke-WebRequest 'https://<站点>/' -UseBasicParsing).Content -match 'client\.js\?v=(\d+-\d+)'

# 2) 进程数回到 3（5 个是正在重叠，5 分钟后还是 5 个才叫残留）
(Get-Process nginx).Count
```

#### ⚠ 2026-10-27 第二次事故：`quit` 清不掉卡住的 worker

维护者要求「现在就重启」，`restart-nginx.mjs --apply` 跑完的结果却是**进程从 14 变成 17、HTTPS 一度 FAIL**。

两个原因，都是这次重写修掉的：

| 坑 | 现象 | 现在怎么做 |
|---|---|---|
| `nginx -s quit` **只让 master 退出**，卡住的 worker 不响应 | 16 个进程只退了 1 个 | 等 10 秒仍不归零 → **强制 `Kill()`**，归零才继续 |
| `_start-nginx.ps1` 开头有「已经在跑就直接退出」的保护 | 看到残留进程 → 什么都不做 → 旧 worker + 新进程混在一起 | 先保证归零、443 释放，**再**触发计划任务 |

还有一条容易忽略的：**`schtasks /Run` 会继承触发者的会话**。若在 nginx 仍在运行时触发，
新任务可能落在桌面会话。所以「先杀干净再启动」同时也是保证 `Session 0` 的前提。

清理后的正常状态（实测）：

```
pid=8744   session=0   ← master，父进程已退出，由内核接管
pid=26956  session=0   ← worker
pid=28708  session=0   ← worker
素材 6.4 MB scene.bin：60–81 秒 → 0.245 秒
```

**判断「有没有挂在你的进程下」的方法**（维护者最关心这一点）：

```powershell
# 1) nginx 的父进程链里【不能】出现当前 shell
Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" |
  ForEach-Object { "$($_.ProcessId) session=$($_.SessionId) 父=$($_.ParentProcessId)" }
"我的 shell = $PID"
# 正常情况下 master 的父进程「已退出」—— 它是孤儿进程，由内核接管
```

父进程断链 + 全部 `session=0` 才算达标。**只有父进程断链、但 session 还是 2，不算达标**
（2026-10-27 中间态就是这样：不会因会话退出而死，但仍挂在桌面会话里）。

**随时自查**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" |
  Sort-Object CreationDate |
  Select-Object ProcessId, SessionId, CreationDate
# SessionId 必须全是 0，进程数必须是 3
```

**为什么用计划任务就能保证 Session 0**：
`SP-Nginx-Start` 的 Principal 是 `SYSTEM` + `LogonType: ServiceAccount`，任务由任务计划程序
（svchost）拉起，父进程是系统服务，与任何登录会话无关 —— 它 fork 出来的 nginx 必然在 Session 0。

**还有一个陷阱**：`deploy/_start-nginx.ps1` 老版本用 `cmd /c start "" /b nginx.exe` 启动，
这会**继承调用者的会话**。由计划任务调用时没问题（继承 SYSTEM 的 Session 0），
但**在桌面终端里直接运行这个脚本，nginx 就会挂到你的会话上** —— 2026-10-27 发现的
8 个 Session 2 进程就是这么来的。现在脚本已改为用 `ProcessStartInfo` 启动并会在日志里
警告「nginx is NOT in session 0」。**永远通过 `schtasks /Run` 或 `tools/restart-nginx.mjs` 启动。**

#### 这一轮的标准流程（照做即可）

```powershell
# 1) 找出空闲节点（matches=0）
& tools\_restart-when-idle.ps1

# 2) 重启（它自己会再复查一次 matches）
& tools\_restart-when-idle.ps1 -Apply

# 3) 重建开放列表（只改 nginx）
node tools\_set-open-nodes.mjs <已重启的节点号，逗号分隔>
```

> ⚠ 第 1、2 步的脚本按 **`lobby.js`** 的 mtime 判断「是否已更新」。
> **如果你这次改的不是 `lobby.js`（比如 `meta.js`、`match.js`），它会误报「30 个都已载入新代码」
> 然后什么都不做。** 这种情况要自己按上面「不能只看 `lobby.js`」那节的办法列出待重启节点，
> 再用 `pm2 startOrReload ecosystem.config.cjs --only node-a,node-b --update-env` 手动重启。

> `_set-open-nodes.mjs` 要传**已重启的节点号**（不是全部节点）。传错会把没更新的节点也开放出去。

`_set-open-nodes.ps1` **不需要传参数**：它自己计算 `node-1/server` + `node-1/shared`
下最新的文件 mtime，凡是「进程启动时间晚于它」的节点算已更新 → 开放，其余关闭。
所以**必须先重启、再跑它**，顺序反了会把所有节点都关掉（脚本检测到空列表会拒绝写入并退出，
不会把站点搞挂）。

> 它只改 `split_clients` 与 `$sp_cookie_open`，不动 `MM_DISABLED_NODES`（见「对外开放哪些节点」一节）。
> 写完会跑 `nginx -t`：**通过才 reload**；不通过则把配置还原成写之前的样子并退出
> （脚本自己备份/回滚，失败不会留下坏配置，也不会中途 reload 出错）。


---

## 三、管理后台

**入口**：大厅「公告」左侧的「管理后台」按钮（仅管理员可见），或直接访问 `https://stronghold.luobomiao.love/mm/admin.html`。

**登录流程**

```
1. 必须先在游戏里登录管理员账号（Cookie sp_sid 有效）
2. 打开后台 → 显示当前账号
3. 点「获取验证码」→ 发到该账号绑定邮箱（10 分钟有效）
4. 输入 6 位码 → 「进入后台」
5. 后台会话绑定 sp_sid，刷新/换浏览器需重新验证
```

**权限等级**

| 角色 | 等级 | 能力 |
|---|---|---|
| `player` | 0 | 无后台权限 |
| `admin` | 2 | 查看账号、封禁/解封、重置密码、改昵称、看详情、看审计（只读） |
| `owner` | 3 | 全部权限：改权限、删除/恢复账号、节点状态与重启、服务器设置、数据占用、审计导出 |

规则：只能操作**严格低于**自己的账号；不能把自己的等级授出。

**页签与功能**

| 页签 | 功能 |
|---|---|
| 玩家账号 | 搜索（邮箱/昵称/代码）、封禁、改名、重置密码、删除、详情 |
| 已删除账号 | 软删除列表，owner 可恢复 |
| 审计日志 | 搜索、动作筛选、导出 CSV（最多 500 条） |
| 节点状态 | 30 节点在线/人数/对局、AI 队友总数、指标趋势图、单节点重启 |
| 数据占用 | 账号云端数据大小排行（Top 20） |
| 服务器设置 | 公告板、创建房间开关（含独立模拟）、房间解散时长、建房状态提示 |

**账号详情**包含：注册时间、最后登录、云端域数量与大小、活跃会话数、最近 10 条审计。

---

## 四、数据库（MySQL 8）

库名 `stronghold`。应用账号 `sp_app`（非 root，仅有 `stronghold.*` 的增删改查/建表权限）；连接参数由 `matchmaker/account.cjs` 读取 `.secrets/secrets.json` 的 `dbHost` / `dbPort` / `dbUser` / `dbPassword` / `dbName`。root 口令只存在于 `dbRootPassword` 与 `.secrets/mysql-root.txt`（备份脚本用）。

| 表 | 当前行数 | 作用 |
|---|---|---|
| `accounts` | 15 | 账号：邮箱、昵称、四位代码、密码 hash、角色、封禁、软删除时间 |
| `user_sessions` | 139 | 游戏登录会话（`sp_sid`），30 天有效 |
| `user_prefs` | 16 | 云端存档，按 `(user_id, domain)` 唯一，`payload` + `version` |
| `admin_sessions` | 17 | 后台会话，`token` + 绑定 `sid` |
| `admin_codes` | 0 | 后台邮箱验证码（一次性，10 分钟） |
| `email_codes` | 1 | 注册邮箱验证码 |
| `reset_codes` | 0 | 忘记密码验证码 |
| `admin_audit` | 22 | 审计日志：操作人、动作、目标、详情、IP、时间 |
| `admin_devices` | 1 | 管理员新设备记录（用于新设备提醒） |
| `admin_users` | 2 | 历史遗留表（当前权限以 `accounts.role` 为准） |

### 常用 SQL

```sql
-- 某账号云端数据
SELECT domain, version, LENGTH(payload) FROM user_prefs WHERE user_id = ?;

-- 最近审计
SELECT actor_email, action, target_id, detail, ip, at
FROM admin_audit ORDER BY id DESC LIMIT 20;

-- 清理过期会话
DELETE FROM user_sessions WHERE expires_at < NOW();

-- 软删除恢复
UPDATE accounts SET deleted_at = NULL WHERE id = ?;
```

### 备份

- 计划任务 `SP-DB-Backup`，每天 **04:00**，保留 **14 天**；
- 脚本：`backups/backup-stronghold.ps1`；
- 恢复：解压对应日期 SQL 后 `mysql stronghold < backup.sql`（操作前先停写：停 matchmaker）。

---

## 五、控制台（dashboard :3080）

| 功能 | 说明 |
|---|---|
| 节点卡片 | 30 个节点在线/离线、人数、对局、内存、重启/停止/启动 |
| 汇总指标 | 在线节点、玩家、房间、AI 队友、内存、匹配服务状态 |
| 指标趋势 | 玩家 / AI / 房间 三条点线图，30 秒采样，保留 24 小时，鼠标悬停看具体时刻 |
| 公告板 | 标题、临时公告、公告列表（写入 `content/`） |
| 建房开关 | 关闭后**包含独立模拟**在内都无法新建房间，5 秒内生效 |
| 房间解散时长 | 1~1440 分钟，写入 `shared/data/room-ttl.json` |
| 日志 | 查看 matchmaker/节点最近日志 |

与管理后台的关系：后台的「服务器设置」是**代理** 3080 的同一套接口（仅 owner）。

---

## 六、日常运维手册

### 改代码后怎么生效

| 改动位置 | 生效方式 |
|---|---|
| `matchmaker/public/*.js`、`node-*/public/js/*`、`mm-mobile.css` | 静态文件，**刷新即可** |
| `matchmaker/account.cjs`、`matchmaker/server.js` | `pm2 restart matchmaker` |
| `node-*/server/*.js` | `pm2 restart node-1 … node-30` |
| `nginx/conf/nginx.conf` | `nginx -t` → `nginx -s reload`（平滑） |
| `shared/data/*.json` | 多数 5 秒内自动重读；房间时长/建房开关无需重启 |

### 发布流程

```powershell
# 1. 备份
.\backups\backup-stronghold.ps1

# 2. 改代码 + 语法检查
node --check matchmaker\account.cjs
node --check node-1\server\lobby.js

# 3. 重启对应进程
pm2 restart matchmaker --update-env

# 4. 验证
curl -o NUL -s -w "%{http_code}" http://127.0.0.1:3090/api/health
curl -o NUL -s -w "%{http_code}" http://127.0.0.1:3080/
# 站点（本机解析）
curl --resolve stronghold.luobomiao.love:443:127.0.0.1 -o NUL -s -w "%{http_code}" https://stronghold.luobomiao.love/
```

### 常见维护动作

| 需求 | 操作 |
|---|---|
| 暂停建房（维护） | 后台 → 服务器设置 → 取消「允许创建房间」 |
| **更新代码但不打断玩家** | 见「重启窗口期：节点分批维护的标准做法」 |
| **某节点要重启但还有人在玩** | 从 nginx 的 `split_clients` 和 `sp_cookie_open` 里移除它（只改 nginx），等它空下来再重启 |
| **放开一个节点** | 加回 nginx 的 `split_clients` 和 `sp_cookie_open`，`nginx -t` + `-s reload` |
| 踢掉某玩家 | 房间内房主踢人；或封禁账号 |
| 重置玩家密码 | 后台 → 玩家账号 → 重置密码（玩家也可自助找回） |
| 解除误封 | 后台 → 封禁按钮切换 |
| 恢复误删账号 | 后台 → 已删除账号 → 恢复 |
| 修改玩家昵称 | 后台 → 改名（1~7 字，代码不变） |
| 查看某人是否在线 | 控制台节点卡片或后台账号详情（活跃会话数） |
| 关闭匹配 | 停 matchmaker 会影响账号与后台，**不要随便停**；应通过公告引导 |

---

## 七、故障排查速查

| 现象 | 先查什么 | 处理 |
|---|---|---|
| 站点 502 | `pm2 list` 节点是否全在线；nginx 是否启动 | 启动节点/nginx；`pm2 start ecosystem.config.cjs` |
| 建房弹「服务器内部错误」 | `pm2 logs node-N --err` 看异常方法名 | 补回被误删的方法/初始化，重启该节点 |
| 全员卡「匹配成功」 | 浏览器控制台 `[mm-debug]`；`/mm/api/party/state` 返回 | 见 HANDOFF 第四节（转场补偿） |
| 图片/立绘全空 | `/assets/~hash/...` 是否 200；素材机是否可访问 | 检查 nginx rewrite 与素材服务器 |
| 云端数据「丢失」 | `SELECT version,LENGTH(payload) FROM user_prefs` | 若被空数据覆盖：本地 localStorage 恢复或备份还原；已有 `mass_removal_guard` 防护；`/api/prefs/merge` 路由与「云端空、本地有」回填已修 |
| 换设备/清缓存后调配、皮肤空白 | 本地是否还有 `sp.pref.loadout` / `sp.pref.skins` | 打开站点登录后会自动回填云端（2026-10-20 已修 merge 路由） |
| 节点重启后房间没恢复 | 是否在 2026-10-20 之前的节点代码上 | 已加建房/开局立即 flush（`lobby.persistFlush`）；若仍丢失，查 `SP_REDIS_PREFIX` 与 `[persist]` 日志 |
| 后台收不到验证码 | 邮箱授权码是否过期；`admin_codes` 是否有行 | 更新 `.secrets`、重启 matchmaker；检查 IP 限流 |
| 玩家刷新回旧房间 | 会话残留 `roomCode` | 已修：`onHello` 校验座位，无座位则清空 |
| 登录 500 | matchmaker 日志 `Max call stack`（ipOf 递归）等 | 修复后重启 matchmaker |
| 节点启动崩溃 `xxx is not a function` | 近期是否批量删过代码 | 从 `deploy/server-patches` 基线恢复该方法 |
| 新玩家还进维护中的节点 | `split_clients` 与 `$sp_cookie_open` 是否都改了 | 两个 map 都要改（见「对外开放哪些节点」），改完 `nginx -t` + `-s reload` |
| 改了 nginx 但没生效 | 是否只 `-t` 没 `-s reload` | 补 `-s reload`；用 `sp_route=<受限节点>` 访问，看 `X-SP-Node` 是否被改派 |
| 5–20 人大厅开不出来 | `MM_EXPERIMENTAL_NODE`（默认 4）是否被限制/离线 | 放开该节点或改指向别的开放节点 |
| 玩家被切到别的节点、对局丢失 | `?room=` / `n=` 分支是否被改动 | 房间上下文优先级必须最高，见「重启窗口期」 |

---

## 八、关键文件索引

| 文件 | 作用 |
|---|---|
| `matchmaker/account.cjs` | 账号、会话、云端存档、管理后台接口、邮件 |
| `matchmaker/server.js` | 匹配服务、节点状态、房间目录、代理后台设置 |
| `matchmaker/public/admin.html` | 管理后台前端（**不上传 GitHub**） |
| `matchmaker/public/account-title.js` | 标题页登录/注册 UI、云同步、代号显示 |
| `matchmaker/public/client.js` | 公告、管理入口、匹配 UI、自动建房流程 |
| `matchmaker/public/mm-mobile.css` | 标题页响应式样式 |
| `node-N/server/lobby.js` | 房间、房主迁移、消极判定、过期解散 |
| `node-N/server/net.js` | WS 握手、hello、tag 同步 |
| `node-N/server/match/*` | 对局逻辑、快照、结算 |
| `node-N/public/js/*` | 前端：大厅、房间、对局、皮肤、商店 |
| `node-N/public/js/boot.js` | 启动诊断 + 脚本加载自动重试 |
| `nginx/conf/nginx.conf` | 反代、注入、缓存、HTTP/2 |
| `ecosystem.config.cjs` | PM2 30 节点配置 |
| `.secrets/secrets.json` | 数据库密码、邮箱授权码（**绝不外传**） |

### 已规划、尚未实现的功能（不要当成现有功能）

| 文档 | 内容 | 状态 |
|---|---|---|
| `../docs-plan/开场动画与登录前置-预案.md` | 登录注册单独成屏 → 点击进入 → 开场动画 → 原标题页（代号框留在原位）→ 大厅。含参考实现 PR #878 的完整代码拆解 | **等待上游 PR #878 合并后接入**；维护者 2026-10-30 明确「不需要你现在接入」 |
| `../docs-plan/login-design/` | **第一屏（登录 / 注册）的设计稿**：`login-screen.css` + `login-screen.html`（**三状态**：登录 / 注册 / 横屏手机，双击可开）+ `phone-preview.html` + `README.md`（视觉参数表、接入步骤、待确认项）。**「已登录」不在设计范围内** —— 它本来就存在于 `account-title.js` 的 `render()` 里，按作者原样保留 | **设计稿完成，未接入任何代码**；2026-10-30 维护者叫停「先暂停吧。我晚点再跟你做」，并明确「再让你加的登录注册界面中也不要出现这个界面」 |

> ⚠ 当前代码里**没有**「点击进入」屏，也没有开场动画（`allianceScene.js` / `entryFilm.js` 都还不存在）。
> 搜 `点击进入` 在 `public/` 下零命中。`public/js/ui/protocolBoot.js` 是**对局内**的「协议启动！」，
> 与启动流程无关，别搞混。

---

## 九、更新 GitHub 前必查（每次提交/推送都要走一遍）

> 这个仓库是**公开**的，同时是**生产代码库**。下面每一条都是踩过的坑。

### 9.1 补丁完整性：最容易出事的一条

本服相对上游的每一处改动，都必须进 `patcher/features/`，否则上游发新版本时按
`restore-patch.bat → 升级 → apply-patch.bat` 走会**全部丢失**。

```powershell
cd D:\Stronghold-Protocol\repo-sync
node patcher/check-coverage.mjs
```

**必须输出 `未进补丁: 0`**，否则先补补丁再提交。

**什么时候必须跑**：改了 `server/`、`public/`、`shared/`、`data/`、`matchmaker/`、`mm/` 下任何文件之后。

**背景（2026-10-26 的事故）**：`patcher/README.md` 一直写着「涉及的游戏文件只有两个」，
是体系初建时的状态。之后功能不断扩张而补丁没跟着加，一度有 **138 个功能代码文件**
不在任何补丁里——5–20 人大厅、并发草稿、悬赏计时、跳过按钮、联防分段、重连窗口、
恢复对局、代号规则全都在内。上游一升级就会全丢。现已补齐并加了自动检查。

补丁覆盖策略见 `patcher/README.md`；哪些路径不纳入补丁也在那里的忽略规则里
（`public/vendor/`、`test/`、`tools/`、`schemas/`、`packs/`、`nginx/`、`package*.json`、
图片、以及上游 gitignore 禁止提交的 `matchmaker/public/admin.html`）。

### 9.11 5–20 人局的结算显示（2026-10-27 修复）

本服有 5–20 人实验房，但结算界面是从官方 4 人模式继承来的，有两处按 4/6 人写死，
多人局会**看不到人**。两处都已修，但**务必记住它们是两件不同的事**：

| 位置 | 原来的问题 | 现在 |
|---|---|---|
| `public/js/ui/stats.js` `MAX_PLAYERS` | 写死 `6`（注释还写着「the game seats 4」），`normalizeRecord` 读**和写**都截断 | 取 `shared/playerCapacity.js` 的 `MAX_PLAYER_CAPACITY`（20） |
| `public/js/screens/settle.js` `TeamPage` | `Math.min(i, 7)` 把第 8 张之后的入场索引全压成 7，20 人时后 12 张同时冒出来 | `staggerOf(i, n)`：索引唯一，步长按人数自适应（8 人内 120ms，20 人 47ms），整排约 1 秒入完 |

**最关键的一条：`public/js` 不是 junction。** 它是每个节点各自的副本，改完必须
`node deploy/sync-nodes.cjs --apply` 分发，否则只有 node-1 是新代码，玩家连到别的节点
看到的还是旧行为（2026-10-27 就因此白查了一轮：改完 node-1 刷新仍是 6 个）。

```powershell
$env:SP_ROOT = 'D:\Stronghold-Protocol'
node repo-sync\deploy\sync-nodes.cjs          # 先看差异
node repo-sync\deploy\sync-nodes.cjs --apply  # 再复制
node repo-sync\deploy\sync-nodes.cjs          # 复检，必须「0 处差异」
```

生效方式：**`public/js` 和 `public/css` 只需玩家刷新页面，不用重启节点**。

#### 已经存下的旧记录救不回来

截断发生在 `normalizeRecord`，而它对**写入**也生效 —— 也就是第 7 名以后的玩家
**从来没进过 localStorage**。修复只对**之后新打的局**有效；已经存成 6 条的记录，
无论怎么改显示层都补不出数据。遇到玩家反馈「以前的记录也缺人」，要如实说明。

#### 结算开场动画（`SettleIntro`）保持官方原样 —— 已确认的决定

> 维护者原话：「结算开场动画还是按照原来的就行了。」

那个「01 02 03 04」的过场是**官方素材驱动的固定演出**：`SEAT_BOX` 只有 4 个坐标，
素材只有 `settle/before_middle_{s,f}_01~04` 四套。它**不是数据界面**，几秒就过、可点击跳过。
按「作者没有做区分就按照作者的设计保存」的原则保持原样，**不要**为了多人局去改它。

真正的数据显示在三个地方，都支持 5–20 人（每个都用 4/5/6/8/10/12/16/20 实测过）：

1. 当场结算 →「数据详情」（`screens/result.js` `ResultView`，纵向滚动）
2. 当场结算 →「同盟战报」（`screens/settle.js` `TeamPage`，横向滚动，自动定位到自己那张）
3. 统计 → 对局记录 → 点一行回看（`recordToResult` → `ResultView`）

### 9.2 不能提交的内容

| 禁止 | 原因 |
|---|---|
| `public/vendor/`、`public/fonts/`、`public/assets/` | AGENTS.md「No game art in git」；上游整包替换 |
| `.secrets/`（GitHub 令牌、测试账号、数据库口令、watch-secret） | 凭据 |
| `*.key`、`privkey.pem`、`*.pem`、`*.pfx`（含 `nginx/conf/ssl/`） | 私钥 |
| `node_modules/`、`logs/`、`.cache/`、`backups/`、`dist/` | 依赖与产物 |
| 明文 GitHub PAT / 数据库密码 | 一律走 `.secrets/` 或环境变量 |
| 本机绝对路径、Windows 用户名 | 仓库公开 |

**事故回顾**：

- `public/vendor/`（9 个）、`public/fonts/`（7 个）、`data/local-fx.json`、`packs/index.json`
  在 `733982fe`「同步 node-1 游戏本体」时被 `git add -f` **强制**加进了仓库，
  绕过了 `.gitignore`，共 4.9 MB。已于 2026-10-26 用 `git rm --cached` 移除
  （本地文件保留）。`check-coverage.mjs` 现在会自动检查这类「被忽略却仍被跟踪」的文件。
- `deploy/_push-maintenance.ps1` 里曾**硬编码 GitHub PAT 明文**（未提交，但留在磁盘就有风险）。
  已改为从 `.secrets/github-token.txt` 读取。

**提交前的自检**：

```powershell
git add -A
git diff --cached --name-only | Select-String '\.key$|privkey|\.pem$|\.pfx$|\.secrets|public/(vendor|fonts|assets)/'
# 必须为空
```

### 9.3 敏感信息不能写死在代码里

仓库公开，所以路径和域名都要可配置：

| 项目 | 正确写法 | 参考文件 |
|---|---|---|
| 部署根目录 | `process.env.SP_ROOT \|\| __dirname` | `ecosystem.config.cjs` |
| dashboard 根目录 | `process.env.SP_ROOT \|\| path.resolve(__dirname, '..')` | `dashboard/server.js` |
| pm2 可执行文件 | `process.env.SP_PM2 \|\| path.join($env:APPDATA, 'npm\pm2.cmd')` | `deploy/server-watchdog.ps1` |
| PM2_HOME | `process.env.PM2_HOME \|\| Join-Path $env:USERPROFILE '.pm2'` | `deploy/_stack-watchdog.ps1` |
| PM2 CLI JS | `process.env.SP_PM2_JS \|\| path.join(APPDATA,'npm/node_modules/pm2/bin/pm2')` | `dashboard/server.js` |
| nginx 目录 | `process.env.SP_NGINX_ROOT \|\| import.meta.dirname` | `nginx/run-nginx.mjs` |
| 资源站域名（前端） | `data/config.json` 的 `assetOrigin`，经 `__spRemoteAssetRe()` 读取 | `public/js/assets.js` 等 6 个文件 |
| 资源站域名（服务端） | `process.env.SP_ASSET_ORIGIN \|\| config.assetOrigin` | `server/http/csp.js` |

**不要**写 `D:\Stronghold-Protocol`、`C:\Users\<用户名>\...`、`https://<你的域名>` 到代码里。

### 9.4 「刷新生效」还是「重启生效」

| 改动位置 | 生效方式 |
|---|---|
| `public/js`、`public/css`、`shared/`、`data/`、`mm/client.js`、`matchmaker/public/` | 玩家**刷新页面**即可 |
| `server/**`（含 `server/net.js`、`server/lobby.js`、`server/match/**`） | **必须重启节点** |
| `dashboard/server.js`、`ecosystem.config.cjs`、`nginx/conf/nginx.conf` | 重启对应进程 / `nginx -s reload` |

**关键陷阱**：`healthz` 的 `build` 字段只覆盖
`public/index.html`、`public/js`、`public/css`、`server/sim`、`shared`、`data`，
**不包含 `server/net.js`、`server/lobby.js`、`server/match/**`**。
所以「所有节点 build 相同」**不能**证明服务端代码已更新。

判断节点是否跑着最新服务端代码，要用**进程启动时间对比 `server/` 目录文件 mtime**：

```powershell
# 进程启动时间
$h = Invoke-RestMethod http://127.0.0.1:3001/healthz
(Get-Date).AddSeconds(-$h.uptimeSec)
# 对照
(Get-ChildItem D:\Stronghold-Protocol\node-1\server -Recurse -Include *.js | Measure-Object LastWriteTime -Maximum).Maximum
```

现成脚本：`tools\_restart-stale.ps1`（只重启 `matches=0` 的旧代码节点）。

### 9.5 改完 `server/` 要分发到 30 个节点（2026-10-27 踩过一次）

`public/css|vendor|assets|i18n|icons`、`data` 是 **junction → `shared/`**，改一处全 30 个节点生效。
但 **`server/`、`public/js/`、`public/dev/`、`public/studio/`、`tools/` 是每个节点各一份，不是 junction**。

```powershell
cd D:\Stronghold-Protocol
node deploy\sync-nodes.cjs --apply   # 分发到 node-2…node-30
node deploy\sync-nodes.cjs           # 复检，必须输出「0 处差异」
```

> **事故经过**：`deploy/_sync-nodes.cjs` 的 `DIRS` 曾刻意排除 `server/`，注释理由是
> 「server 改动要重启节点，不在这里做」。但它其实是唯一的多节点分发手段，于是形成一个陷阱：
> **`server/` 代码永远不会被复制到 2–30 号节点**，那些节点一直跑建服当天（10-25）的版本，
> 重启也拿不到新功能。鸭爵叠加上线时才暴露：node-1 已更新并验证通过，其余 29 个节点
> 连 `meta.js` 都是旧版。已修复（`bf9a7c58`，`DIRS` 加入 `'server'`），脚本入库为
> `deploy/sync-nodes.cjs`，部署根目录改读 `SP_ROOT`。

**注意两个坑**：

1. **`Copy-Item` 会保留源文件的 mtime**。手动复制到各节点后，时间戳看起来还是旧的，
   用「进程启动时间 vs 文件 mtime」判断会误判。用 `deploy/sync-nodes.cjs` 的差异报告
   或内容哈希核对，不要只看时间戳。
2. **`healthz.build` 不能证明服务端已更新**（见 9.4）。前端 `room.js` 之类的改动会立刻下发，
   但服务端逻辑要重启，两层要**分别验收**。

### 9.6 新增功能要登记（不要让功能"半丢"）

每加一个本服独有功能，**同一个提交里**必须做两件事：

1. 改动文件归档进 `patcher/features/<feature>/files/` —— `node patcher/check-coverage.mjs` 会检查
2. **在 [patcher/README.md](patcher/README.md) 的「本服新增功能登记表」加一行**：
   功能名、涉及文件、所属补丁、生效方式

**第 2 条没有任何脚本能自动检查。** `check-coverage.mjs` 只能保证「文件进了补丁」，
不能保证「升级时有人记得验收它」。漏登记的功能在升级后变成「代码还在，但没人知道它存在、
也没人验收」——等于半丢。

补丁 README 里还维护着一份「⚠ 已知陷阱」清单（同步漏 `server/`、`build` 字段不覆盖
`server/`、`Copy-Item` 保留 mtime、前后端两层要分别验收），改动相关代码时一并更新。

### 9.7 重启纪律（线上 30 节点）

**硬约束：正在对局的节点一律不动。**

| 判定 | 动作 |
|---|---|
| `matches > 0` | **禁止重启**，等对局结束 |
| `matches = 0`（含开着房间未开局、只有停留页面连接） | 可以重启 |
| 单人局在跑 | 视同有对局，不动 |

重启后要校验 `healthz.ok === true` 且 `uptimeSec` 很小。

**现成工具**：

```powershell
# 只报告：已载入新代码 / 空闲待重启 / 有对局不动
pwsh -File tools\_restart-when-idle.ps1
# 真的重启（会自己再复查一次 matches）
pwsh -File tools\_restart-when-idle.ps1 -Apply
```

#### ⚠ 重启后房间又回来了？那不是没重启成功

房间状态持久化在 Redis 的 `sp:nN:lobby:rooms`（**hash 类型**，`get` 会报 WRONGTYPE，
要用 `hkeys` / `hdel`）。只重启进程的话，服务端启动时会把房间读回内存，`rooms` 数不变，
看起来像「重启了什么都没变」。

```powershell
# 先确认是死房间（无人连接）再删
D:\Redis\redis-cli.exe hkeys sp:n2:lobby:rooms
D:\Redis\redis-cli.exe hdel  sp:n2:lobby:rooms <CODE>
# 然后再重启节点
```

`state/snapshot.json` 通常已经是空的（`{"v":1,...,"rooms":[],"sessions":[]}`），
真正留住房间的是 Redis 那一份。

#### 卡死对局会挡住重启

判据 `sockets === 0 && matches > 0`（有对局但没有任何连接）。
排查：`node tools/find-zombie-rooms.mjs`。真人都断线的房间会在 TTL 后自动回收
（`sweepOldRooms`），但**那需要节点跑着含该修复的代码**，旧代码会一直挂着。

**开放列表**由 nginx 的 `split_clients` / `$sp_cookie_open` 决定：只开放「已重启到最新代码」的节点，
其余关闭。用 `tools\_set-open-nodes.ps1` 重建（会自动校验百分比合计 = 100%）。

### 9.9 服务器必须自启动，**绝不能依赖任何登录会话**（2026-10-27 事故）

> 维护者原话：「不要让我必须启动你我才能启动服务器」
> 以及事后：「把这些记在维护手册上，以后不要出现了」

**这是本手册里优先级最高的一条红线。** 违反它的后果是全体玩家断线，而且当时没有任何自动恢复。

#### 事故经过（完整时间线）

| 时间 | 发生了什么 |
|---|---|
| 某时 | 某个 AI 助手会话里执行了 `pm2 start` 之类的命令 —— 服务器从此**挂在了那个会话下面** |
| 15:13 | 维护者重启那个桌面应用（AI 助手 DSH） |
| 15:13:20 | 那个应用的 shell 被杀 → **pm2 收到退出信号跟着死** → 30 个节点全部消失 |
| 15:13–15:16 | 全体玩家看到「**与服务器的连接已中断，正在重连**」（第 7 次重试） |
| 15:16 | 2 分钟一次的看门狗写了条 `ALERT missing PM2 apps`，然后**什么都不做**（见下） |
| 之后 | 直到有人手动恢复才回来 |

根因两步：

1. **`pm2 Daemon.js` 的父进程 = DSH 的 pwsh shell**。父进程链挂在那个应用下，
   应用一重启，pm2 就跟着死。
2. **当时的看门狗只报警不修复**。`deploy\_stack-watchdog.ps1` 的注释白纸黑字写着：

   ```
   Alert only: this watchdog never starts or restarts nginx / PM2 / game nodes.
   ```

   于是「有监控」= 「有日志」，等于没有。

#### 现在的机制（三层，全部与登录会话无关）

| 层 | 机制 | 作用 |
|---|---|---|
| 1 | 计划任务 `SP-PM2-Resurrect`（SYSTEM，`PT1M`） | **开机触发（延迟 30s）+ 每 1 分钟**运行 `deploy\_start-pm2.ps1`；pm2 守护进程不在就 resurrect |
| 2 | 计划任务 `SP-Stack-Watchdog`（SYSTEM，每 2 分钟） | `deploy\_stack-watchdog.ps1` 现在会**真的修复**：pm2 不在 → 拉起；应用缺失 → 逐个 start；最后 `pm2 save` |
| 3 | `pm2 save` 的进程表 | 任何时刻 resurrect 都能复原 32 个应用 |

角色分工（这是关键）：

```
任务计划程序 (SYSTEM, Session 0)
        │
        └─→ pm2 Daemon → 30 个游戏节点 + matchmaker + dashboard
                ▲
                └── 每 60 秒被 SP-PM2-Resurrect 检查一次

DSH / 终端 / 任何交互式程序  ←  与上面这条链【毫无关系】
```

#### 怎么验证它真的独立（每次改动后都要做）

```powershell
# 1) pm2 必须跑在 Session 0（系统服务会话），而不是 2（桌面会话）
$g = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'pm2[\\/]lib[\\/]Daemon\.js' } | Select-Object -First 1
"SessionId = $($g.SessionId)"     # 必须是 0
# 对比你自己的 shell：应该是 2
"我的 shell SessionId = $((Get-Process -Id $PID).SessionId)"

# 2) 冷杀测试：杀掉 pm2，90 秒内必须自己回来
Stop-Process -Id $g.ProcessId -Force
# 等 60–90 秒后
pm2 list                          # 应该恢复
```

2026-10-27 实测：杀掉 pm2 后 **6 秒**被计划任务拉起，33 个应用全部恢复，30/30 节点响应。

#### ⚠ 脚本以 SYSTEM 运行时特有的两个坑（都踩过，会让自启动"看起来生效其实没有"）

**1. `$env:APPDATA` / `$env:USERPROFILE` 指向 SYSTEM 的目录，不是管理员的**

```
$env:APPDATA = C:\WINDOWS\system32\config\systemprofile\AppData\Roaming
```

npm 全局包不在那里 → 脚本报 `PM2 not found at ...systemprofile...`，任务结果码非 0。
`PM2_HOME` 同理：指错了 `resurrect` 会「成功但什么都没恢复」，比直接失败更难查。

正确做法：**按候选顺序探测**（见 `deploy\_start-pm2.ps1` 顶部的 `$pm2Cmd` / `$env:PM2_HOME` 推导），
或用环境变量 `SP_PM2` / `PM2_HOME` 显式指定。

**2. 先 `ReadToEnd()` 后 `WaitForExit()` 会永久阻塞**

```powershell
# ❌ 错误：子进程不关 stdout 时 ReadToEnd 永不返回，WaitForExit 的超时形同虚设
$out = $p.StandardOutput.ReadToEnd()
$p.WaitForExit(30000)

# ✅ 正确：先等退出（带超时），确认已退出再读流
if ($p.WaitForExit(20000)) { $out = $p.StandardOutput.ReadToEnd() }
else { $p.Kill() }
```

实测后果：计划任务实例卡了 63 秒以上不结束，下一次触发被 `IgnoreNew` 跳过，
**看起来完全像"自启动没生效"**，实际是脚本自己噎死了。

**3. 结果码怎么看**

| 码 | 含义 | 要不要管 |
|---|---|---|
| `0` | 正常结束 | — |
| `267009` / `0x00041301` | 任务正在运行中 | 不用管 |
| `2147946720` / `0x800710E0` | 上一次还没跑完，本次被跳过 | 不用管；**但若每次都这样**，说明脚本卡死了（见第 2 条） |

#### 🚫 绝对不要做的事（红线）

| 禁止 | 原因 | 后果 |
|---|---|---|
| **在 AI 助手 / 终端 / 任何交互式 shell 里跑 `pm2 start` / `pm2 resurrect` / `pm2 reload`** | pm2 会挂在那个会话的进程树下面 | 该应用一重启，**服务器全断** |
| 关掉或删除 `SP-PM2-Resurrect` / `SP-Stack-Watchdog` 计划任务 | 失去自愈能力 | 下次崩溃需人工恢复 |
| 把看门狗改回「只报警、不修复」 | 事故就是这么发生的 | 有监控等于没监控 |
| 让服务器「先手动起一下、以后再做成自启动」 | 临时方案会变成永久 | 迟早再断一次 |
| 用 `pm2 start ecosystem.config.cjs` 做「检查/恢复」 | 它会对**已在跑**的应用逐个 `restartProcessId` | **打断正在进行的对局** |
| 依赖「我手动 resurrect 一下就好」 | 凌晨崩溃时没人在 | 玩家长时间无法游戏 |

#### ✅ 唯一正确的启动方式（三种，任选）

| 方式 | 操作 |
|---|---|
| **双击**（推荐，不用记命令） | 双击部署根目录的 **`启动服务器.bat`** |
| 命令行 | `schtasks /Run /TN "SP-PM2-Resurrect"` |
| 等价脚本 | `powershell -File deploy\start-server.ps1` |

三者都走「计划任务 → SYSTEM → Session 0」这条链，**关掉窗口 / 注销 / 重启桌面应用都不影响**。

`启动服务器.bat` 做的事：调计划任务 → 等 25 秒 → 打印 `pm2 list` 与 30 个节点 + 3080/3090 端口的检查结果。
它只是**触发器**，不是服务器的宿主 —— 这正是它能安全关闭的原因。

#### 🔍 「以后不要出现了」——每次动过运维配置就跑这三条

**第 1 条：确认 pm2 不在任何交互式会话里**

```powershell
$g = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'pm2[\\/]lib[\\/]Daemon\.js' } | Select-Object -First 1

"SessionId = $($g.SessionId)"                 # 必须是 0
"我的 shell = $((Get-Process -Id $PID).SessionId)"   # 应该是 2

# 往上追父进程：必须【不在】任何 Harness / pwsh / explorer 的树里
$cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($g.ParentProcessId)" -ErrorAction SilentlyContinue
for ($i=0; $i -lt 6 -and $cur; $i++) {
  "$($cur.Name) (pid $($cur.ProcessId))"
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
}
```

**第 2 条：冷杀测试（这是唯一能证明它独立的证据）**

```powershell
Stop-Process -Id $g.ProcessId -Force
# 等 60–90 秒
pm2 list        # 应该自己回来了
```

**第 3 条：确认计划任务还在、还在跑**

```powershell
Get-ScheduledTaskInfo -TaskName 'SP-PM2-Resurrect'   # NextRunTime 要一直更新
Get-ScheduledTaskInfo -TaskName 'SP-Stack-Watchdog'
```

#### 🆘 再出问题时：两分钟定位

按顺序看，第一处「否」就是问题所在：

| 检查 | 命令 | 正常 |
|---|---|---|
| 计划任务存在吗 | `schtasks /Query /TN "SP-PM2-Resurrect"` | 存在 |
| 它最近跑过吗 | `Get-ScheduledTaskInfo -TaskName 'SP-PM2-Resurrect'` | `NextRunTime` 持续更新 |
| 跑了但没效果？ | `Get-Content logs\pm2-resurrect.log -Tail 10` | 有 `start-pm2 done` |
| 日志报 `PM2 not found`？ | 见上面「SYSTEM 路径坑」 | — |
| 任务实例堆积？ | `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" \| ? CommandLine -match '_start-pm2'` | 0 个（有则说明卡死，见 `ReadToEnd` 坑） |
| 看门狗有动手吗 | `Get-Content logs\stack-watchdog.log -Tail 10` | 有 `PM2 daemon is down -> resurrect`，不是只有 `ALERT` |

#### ✅ 「重启节点」这个动作本身是安全的（2026-10-27 实测确认）

维护者问过：「你确认重启的进程不是在你的进程中的。」**确认，实测数据如下。**

**关键区别**（这是整件事的核心）：

| 动作 | 谁 fork 新进程 | 结果 |
|---|---|---|
| 在交互式 shell 里 `pm2 start` / `pm2 resurrect` | **shell** 拉起 pm2 守护进程 | pm2 挂在该会话下 → **会话死 = 服务器死**（事故就是这么来的） |
| `pm2 restart node-N` / `pm2 startOrReload` | **pm2 守护进程自己** | 新进程父进程永远是 pm2 → **与会话无关** |

`pm2 restart` 的命令行客户端只是个**临时进程，发完指令就退出**，它不持有任何应用。

**实测（2026-10-27）**：

```
重启前  node-2 pid=30196  父=33768(pm2)  SessionId=0
执行    pm2 restart node-2 --update-env      ← 由 AI 助手会话发起
重启后  node-2 pid=30384  父=33768(pm2)  SessionId=0   ← 父进程没变
对比    我的 shell pid=31876  SessionId=2
```

新进程的父进程仍然是 pm2，**不是发起命令的会话**。

**完整进程树**：

```
任务计划程序 (SYSTEM, Session 0)
   └─ pm2 Daemon (33768, Session 0)   ← 父进程已退出，完全脱离启动者
        ├─ node-1 … node-30  (33 个应用, Session 0)
        ├─ matchmaker
        └─ dashboard

executive shell / AI 助手 (Session 2)  ← 只是「发命令的手」，不持有任何进程
```

**随时可以自查**（三条命令）：

```powershell
# 1) pm2 是否在 Session 0
$g = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'pm2[\\/]lib[\\/]Daemon\.js' } | Select-Object -First 1
"pm2 SessionId = $($g.SessionId)"        # 必须是 0

# 2) 有没有游离的 node 进程（不挂在 pm2 下）
$all = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
$all | Where-Object { $_.ParentProcessId -ne $g.ProcessId -and $_.ProcessId -ne $g.ProcessId } |
  ForEach-Object { "⚠ 游离: pid=$($_.ProcessId) parent=$($_.ParentProcessId)" }
# 应该没有任何输出

# 3) 重启后复查：新进程的父进程必须还是 pm2
pm2 restart node-N --update-env
$c = Get-NetTCPConnection -LocalPort (3000+N) -State Listen
(Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").ParentProcessId   # 必须 = $g.ProcessId
```

**结论**：AI 助手 / 终端里执行 `pm2 restart` **完全安全**；危险的是 `pm2 start` / `pm2 resurrect`
（首次拉起守护进程）。这就是为什么本手册要求启动一律走「双击 `启动服务器.bat`」或计划任务。

#### 相关文件

| 文件 | 作用 |
|---|---|
| `deploy\_start-pm2.ps1` | 以 SYSTEM 身份启动/恢复 pm2，幂等（已在跑就不重复启动）。**读不到 jlist 时整轮跳过**，不再把「读不到」当成「全都没了」 |
| `deploy\_stack-watchdog.ps1` | 每 2 分钟的看门狗，会自动修复；**永不 `resurrect` 去补缺失应用**（详见 §9.12） |
| `deploy\restart-watch.ps1` | 每 10 分钟的重启巡检，比对运行时长，只要变小就记 `RESTART DETECTED`（§9.12） |
| `deploy\server-watchdog.ps1` | 旧看门狗脚本；对应任务 `Stronghold-Server-Watchdog` 已 **Disabled** |
| `logs\stack-watchdog.log` | 看门狗的处置记录（`PM2 daemon is down -> resurrect` 等） |
| `logs\pm2-resurrect.log` | `_start-pm2.ps1` 的日志 |
| `logs\restart-watch.log` | 重启巡检记录；排查「玩家说一直在重启」先看这个 |

> ⚠ 计划任务 `Stronghold-Server-Watchdog` 已禁用（它曾以 `Interactive` 身份每分钟在你的
> 桌面会话启动 PowerShell，窗口会闪）。它的 nginx 抢救职责已并入 `_stack-watchdog.ps1`。

**绝不能**因为节点不在开放列表就把 `sp_route` cookie 改派走——那会让正在对局的玩家断线重连后
回不到原节点，表现为「回不到对局」。`sp_route` 必须无条件尊重，开放列表只管没有 cookie 的新访客。

### 9.10 日常运维：双击 `运维.bat`，不用记命令（2026-10-27 新增）

> 维护者原话：「能不能都写成脚本让我操作呢」「不能我直接点击某个脚本就开启吗一定要输入命令吗」

部署根目录的 **`运维.bat`** 打开一个菜单，把日常动作都收敛成「选数字」：

| 菜单 | 做什么 | 有副作用吗 |
|---|---|---|
| 1 | 服务器总览：30 节点响应 / 房间 / 对局 / 在线人数，每节点标 `新`(已载新代码) 或 `旧`，外加 nginx、pm2、网站状态 | 无（只读） |
| 2 | 列出「跑旧代码 + `matches = 0`」的节点，即**现在就能重启**的那些；标出有对局不能动的 | 无（只读） |
| 3 | 重启上面那些空闲节点（`pm2 startOrReload --only …`，逐个复查 `matches` 后再动） | 会断线 1–2 秒 |
| 4 | 把 nginx 开放列表改成「所有已跑新代码的节点」（调 `tools\_set-open-nodes.mjs`，自动备份 + `nginx -t` + 失败回滚） | 只影响新访客 |
| 5 | 重启 nginx（走计划任务 → SYSTEM → Session 0，清理残留 worker） | 断线 1–2 秒 |
| 6 | PM2：经计划任务启动/恢复（**绝不**在菜单里直接 `pm2 start`）、查看列表 | 见 9.9 红线 |
| 7 | 日志：素材加载失败、最慢的素材、nginx 启动日志、看门狗日志、单节点错误日志 | 无（只读） |

**菜单只会「先报范围、再确认」**：3/4/5 都先打印将被影响的节点与对局数，输入 `y` 才执行。
只读项（1/2/7）随便点，任何情况下不会改东西。

#### 两个必须记住的实现细节（都踩过）

**1. `pm2` 必须用 `pm2.cmd`，不能用 `pm2.ps1`**

`pm2.ps1` 会重新切分参数，`--only node-5,node-29` 传不进去，`startOrReload` 退化成
**无参数调用 = 重启全部 30 个节点**。菜单里用 `Get-Pm2` 固定取 `%APPDATA%\npm\pm2.cmd`。
手动敲命令同理：**在 PowerShell 里写 `pm2.cmd`**，或用 `cmd /c pm2 …`。

**2. 双击 `.bat` 跑的是 Windows PowerShell **5.1**，不是 pwsh 7**

5.1 没有 `??`（空合并）运算符。第一次写完就因为这个**整个脚本解析失败、菜单根本打不开**，
但在 pwsh 7 里 `Parser::ParseFile` 是通过的——**所以不能用 pwsh 7 验证**。

```powershell
# 验证 .ps1 能在 5.1 下解析（改过 deploy\*.ps1 后必须跑这条）
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command `
  "`$e=`$null; [void][System.Management.Automation.Language.Parser]::ParseFile('<路径>',[ref]`$null,[ref]`$e); `$e"
# 无输出 = 通过
```

同理不要用 `-Parallel`、`??`、`?:`、`Get-Content -AsByteStream` 等 7 才有的语法。
所有 `deploy\*.ps1` 还必须存成 **UTF-8 with BOM**，否则 5.1 会把中文读成乱码。

#### 新增节点的标准动作（照着做就不会漏）

```
菜单 2 看谁能动  →  菜单 3 重启它们  →  菜单 4 更新开放列表  →  菜单 1 复查（代码列全变「新」）
```

**顺序不能反**：先重启、后开放。反过来会把新玩家导到还在跑旧代码的节点上（维护者的红线：
「把可以更新重启的节点对外开放，不能重启更新的节点不对外开放」）。

#### 相关文件

| 文件 | 作用 |
|---|---|
| `运维.bat` | 双击入口（ASCII 文件名 + 调 `deploy\ops-menu.ps1`） |
| `deploy\ops-menu.ps1` | 菜单本体，UTF-8 BOM，兼容 PowerShell 5.1 |
| `tools\_set-open-nodes.mjs` | 安全改写 nginx 开放列表（Node 写，不产生 BOM；备份 + `nginx -t` + 失败自动还原） |
| `tools\restart-nginx.mjs` | 报告 / `--apply` 重启 nginx，重启后校验所有进程 SessionId = 0 且 HTTPS 200 |
| `tools\_restart-when-idle.ps1` | 命令行版「重启空闲节点」，但**判断新旧只看 `lobby.js` mtime**，改过别的文件会误报「已载入新代码」 |

> ⚠ `tools\_set-open-nodes.ps1` 是**废弃**的旧版：`Set-Content -Encoding UTF8` 会给 `nginx.conf`
> 加 BOM，导致 `nginx: [emerg] unknown directive "﻿worker_processes"`。只留作参考，不要用。

#### 同样的功能也在节点控制台里（网页版，2026-10-27 整合）

> 维护者原话：「那你把他整合进节点控制台吧」

打开 **`http://127.0.0.1:3080/#ops`**（节点控制台 →「防护与日志」标签页最下面的「运维」块），
不用开终端就能做同样的事：

| 界面 | 对应菜单 | 说明 |
|---|---|---|
| `19 / 30 个节点已跑最新代码` + 代码时间 | 菜单 1 | 口径与脚本一致：**进程启动时间 ≥ `server/` 下最新 .js 的 mtime** 才算新代码 |
| 「可以重启的节点」绿色标签 | 菜单 2 | 逐节点显示房间数/连接数；下面黄色一行列出「跑旧代码但正在对局，不能动」的节点及局数 |
| 「重启这 N 个空闲节点」 | 菜单 3 | 弹窗列出节点名 + 影响，确认后执行 |
| 「更新 nginx 开放列表」 | 菜单 4 | 弹窗确认；调同一个 `tools\_set-open-nodes.mjs`（备份 / `nginx -t` / 失败回滚） |
| 「当前开放 N 个；已跑新代码 M 个」 | — | 若出现 `⚠ 有旧代码节点还开着` 就是违反了红线，要立刻处理 |

后端是 `dashboard/server.js` 的三个接口：`GET /api/ops/state`、`POST /api/ops/restart-idle`、
`POST /api/ops/open-list`（两个 POST 都**必须**带 `confirm: true`，否则 400）。

**三道防误伤的闸**（网页版比命令行更需要，点错一下就可能打断对局）：

1. 前端弹窗确认，列出具体节点名和影响；
2. 后端要求 `confirm: true`；
3. 执行前**再逐个 `probe()` 复查 `matches === 0`**，有变化就剔除并在结果里报 `skipped`。

> 控制台标签页支持 hash 直达：`#overview` / `#match` / `#settings` / `#ops`。

**改了 `dashboard/` 之后必须同步并重启 dashboard**：

```powershell
Copy-Item dashboard\server.js, dashboard\public\app.js, dashboard\public\index.html repo-sync\dashboard\ -Force
pm2.cmd restart dashboard --update-env     # 注意是 pm2.cmd，不是 pm2.ps1
```

`dashboard/` 在仓库里也是**独立一份**（不是 junction），漏同步就会「线上改了、仓库没改」。
dashboard 重启不影响任何对局（它只读 `pm2 jlist` 和各节点 `/healthz`）。

> ⚠ **方向别搞反**：pm2 拉起的是**部署目录**的 `D:\Stronghold-Protocol\dashboard\server.js`，
> 不是 `repo-sync\dashboard\`。所以在仓库里改完不复制过去，线上**一点变化都没有**，
> 而 `pm2 restart dashboard` 也救不回来（它重启的仍是部署目录那份）。
> 2026-10-31 加「自动同步状态」时就先踩了这一步：改了 `repo-sync` 的文件、刷新控制台没反应。
> 判据：`Get-FileHash` 比一下两边的 MD5，或者直接 `curl http://127.0.0.1:3080/app.js`
> 看里面有没有你刚加的函数名。

#### 自动同步状态行（「部分节点关掉后还能用」的监控）

运维面板「更新 nginx 开放列表」下面那行灰色小字，是**计划任务 `SP-Open-Nodes` 上一次实际执行的结果**：

```
自动同步：2 分钟前　在线 30　配置无变化　上次结果：配置无变化，不 reload
```

- 数据来自 `logs/open-nodes.log` 最后一块，由 `dashboard/server.js` 的 `readOpenSync()` 解析，
  挂在 `GET /api/ops/state` 的 `openSync` 字段上；
- 上面那行「当前开放 N 个；已跑新代码 M 个」是**按 nginx 当前配置算出来的期望值**，
  这一行是**自动任务实际做了什么**——两者不一致就说明定时任务停了；
- **超过 15 分钟没跑**会标红（任务每 5 分钟一次），告诉你去看计划任务；
- `dead > 0` 也会标红并列出挂掉的节点编号。

这条链路就是「保证在部分节点关闭的状态下也能用」所依赖的东西：节点挂了 → 5 分钟内
`open-nodes.conf` 被重写（把死节点从 `split_clients` 和 `map $cookie_sp_route` 里摘掉）→
nginx reload 后新访客不会分到死节点，而已经分到过的浏览器也会被判为 cookie 无效、重新随机。
所以**这一行变红 = 玩家正在被往死节点上分**，要当事故处理，见 §9.34。

---

### 9.34 开放列表的口径：**谁活着谁就开放**，绝不能「谁代码新就开放」（2026-10-31）

#### 结论（先记住这一条）

`nginx/conf/open-nodes.conf` 里的两个块，语义完全不同，别搞混：

| 块 | 决定什么 | 节点少了会怎样 |
|---|---|---|
| `split_clients` | **新访客**（没有 cookie）随机分到哪 | 少了无所谓，只是不往那分 |
| `map $cookie_sp_route` | **老玩家的 cookie 还算不算有效** | ⚠ **少了就是事故**——那台节点上的玩家一刷新就掉回大厅 |

所以这两个块**永远只能按「节点是否活着」来写**，不能按「节点是否跑了新代码」来写。

#### 事故经过（当天犯了两次，第二次是自己造成的）

上午刚修完「刷新掉回大厅」，根因是 nginx 的开放白名单只有 11 个节点、**node-1 不在里面**：

```
玩家在 node-1 对局中刷新 → 带 sp_route=1 → map 里没有 1 → $sp_cookie_open=0
→ 判定 cookie 失效 → 重新随机分到别的节点 → 新节点没有他的会话 → 掉回大厅
```

修法是把 30 个节点全放开（并加 `sync-open-nodes.ps1` 按存活自动维护）。
但**控制台那个「更新 nginx 开放列表」按钮还留着旧逻辑**：把列表写成「所有已跑新代码的节点」。
当天有 12 台节点因为上面在对局、没法重启，仍是旧代码 → 点一次按钮就把它们从 `map` 里摘掉 →
**那 12 台节点上的玩家刷新即掉大厅**，等于把一个刚修好的 Bug 原样重新引爆。

它还会更糟：`_set-open-nodes.mjs` 去 `nginx.conf` 里找 `split_clients`，
而那个块当天已移进 `open-nodes.conf`，于是按钮直接报 `找不到 split_clients 块` 而失败。
**失败反而是好事**（脚本有回滚），真正危险的是它成功的时候。

#### 现在的口径（维护者 2026-10-31 定稿）

> **「根据代码判断，不想手动控制每个节点」** ——
> 跑旧代码的节点自动不接新玩家；那台上**已经在玩的人完全不受影响**。

`nginx/conf/open-nodes.conf` 里三个块的语义**故意不同**，各写各的：

| 块 | 决定什么 | 写哪些节点 |
|---|---|---|
| `split_clients` | 新访客（无 cookie）随机分到哪 | **存活 且 已跑新代码** |
| `map $cookie_sp_route` | 老玩家的 cookie 还算不算有效 | **全部存活节点**（含旧代码） |
| `map $sp_node $sp_node_accepts_new` | 通知前端「本节点还接不接新玩家」 | 新代码 = `1`，其余 `0` |

第二块**必须含旧代码节点**，否则那台上的人刷新就掉回大厅（就是 §9.34 的事故）。
第三块只用于结算页的一句提示，不参与路由。

**为什么这样就能两头兼顾**：刷新时地址栏带着 `?room=CODE`（进房时写进 URL 的），
nginx 的 `if ($arg_room ~ "^[A-Za-z0-9]{4,6}$") { set $sp_node $cookie_sp_route; }`
会强制回原节点，不受 `split_clients` 影响。所以：

- 新访客 → 不进旧代码节点（`split_clients` 里没有它们）
- 旧代码节点上的玩家 → 刷新、重连、继续玩全部正常（走 `map` + `?room=`）

**已实测验证**（`tools/e2e-refresh-on-stale.mjs`，2026-10-31）：

```
✓ 首页落在 node-1（旧代码节点）
✓ 建房 → 房间 JRHX
✓ 刷新后仍落在 node-1（未被改派）
✓ 刷新后仍在房间 JRHX
✓ playerId 未变（p_736aa34c08）
```

另一侧也验证过：40 次无 cookie 请求，**0 次**落到旧代码节点。

#### 唯一会改这份文件的东西

`tools/sync-open-nodes.ps1`（计划任务 `SP-Open-Nodes`，每 5 分钟）。
它的代码新旧判断来自 `GET /api/ops/state` 的 `stale`（dashboard 按 pm2 进程启动时间算的，
**不用 `/healthz.build`**——那个字段不含 `server/net.js`、`server/lobby.js`）。

- 拿不到 `/api/ops/state` 时**不下判断**，按「全部算新代码」放行：宁可让新玩家进旧代码节点，
  也不能反过来误伤 `map`（那才会掉大厅）。
- 万一所有存活节点都是旧代码，`accept` 会退化为「全部存活」，否则新玩家无处可去。

#### 玩家怎么换到新节点

旧代码节点上的人打完一局后，结算页会出现一行提示（`public/js/ui/nodeCodeHint.js`）：
「这台服务器还在使用旧版本。本局已结束，刷新页面即可换到新版本。」
刷新后 `split_clients` 之外的 `map` 分支已经不含该节点，浏览器自然被分到新代码节点。

`X-SP-Accepts-New` 响应头就是给它用的（`1` 接新 / `0` 不接），
主要在结算页读，**不在对局中打扰**——对局中刷新有风险，而提示的意义只是「什么时候方便就刷新」。
大厅和房间准备阶段也会读（走 `connBanner.js` 的横幅），但**对局中一律不显示**，
规则见下一节的「提示出现在哪几个地方」。

##### ★ 提示出现在哪几个地方（2026-10-31 扩全 + 限定）

**维护者最终确定的规则（2026-10-31 晚）：只在大厅、房间准备阶段、结算界面提示；
对局中（从 `INFO_CHECK` 选人到 `SETTLE` 休整）一律不弹。**

界线由 `public/js/ui/buildGuard.js` 的 `updateHintAllowed(route, phase)` 一处决定，
`connBanner.js` 用它把横幅整个挡掉（连 `html.sp-conn` 也不加，否则 toast 会被无谓地下压）：

| 界面 | `selectRoute` | `m.public.phase` | 提示 |
|---|---|---|---|
| 大厅 | `lobby` | — | ✅ |
| 房间准备阶段 | `room` | — | ✅ |
| 标题页 | `title` | — | ✅ |
| **结算界面** | `game` | `RESULT` | ✅ |
| 对局中（选人/选角/备战/战斗/休整） | `game` | 其余全部 | ❌ |
| 开局瞬间（`m.public` 还没到） | `game` | `undefined` / `LOBBY` | ❌ |

⚠ **结算界面的 `selectRoute` 仍然是 `game`** —— 只看路由会把结算也一并挡掉。
所以必须同时看 `phase`：`route !== 'game'` 或 `phase === PHASE.RESULT` 才放行。

| 位置 | 组件 | 判据 |
|---|---|---|
| 单人结算页 | `result.js` 的 `ResultView` → `NodeCodeHint` | `X-SP-Accepts-New: 0` |
| **同盟结算页** | `settle.js` 的 `TeamPage` → `NodeCodeHint` | 同上 |
| **大厅 / 房间准备 / 结算** | `connBanner.js` 的横幅（顶部居中） | ① `buildStale`（本节点 build 变了）**或** ② `X-SP-Accepts-New: 0`（在跑旧代码），且 `updateHintAllowed` 放行 |
| 对局中 | 同上，但**被 `updateHintAllowed` 挡掉，不显示** | — |

这里有两个**完全不同**的判据，别混：

- **`buildStale`** —— 这一页加载之后，**同一节点**的 `/healthz.build` 变了（节点重启换版）。
  `ui/buildGuard.js` 负责，60 秒查一次。
- **`X-SP-Accepts-New: 0`** —— nginx 说这台节点不接新玩家了，也就是它**在跑旧代码**。
  这台节点可能从开机起就没变过 build（`buildGuard` 永远不会报），
  但玩家该刷新换节点。**这是维护者在 node-7 上等不到提示的原因。**

##### 四个曾经踩过的坑

1. **离开房间就 `buildGuard.stop()`** → 之后再也不检查版本，大厅里永远收不到提示。
   改成 `buildGuard.resume()`：只保证表没停，**不动「已判定为旧版本」这个结论**。
   ⚠ 别再改回 `reset()`：`reset()` 会把 `stale` 清成 false，而 `known` 还停在旧 build，
   要再攒 2 次确认（约 2 分钟）才会重新触发 —— 中间那段时间玩家在大厅/结算页什么也看不到。
   也**不能**把 `known` 清成 null —— 页面没刷新，`known` 没变；清掉之后下一轮当 first 处理，
   会把服务器当前 build 记成基准，**「服务器确实换版了」这件事就再也发现不了**。
2. **同盟结算页没挂 `NodeCodeHint`** → 单人打完有提示，同盟打完什么都没有。
3. **同盟结算页挂了但看不见** → `.settle__stage` 是
   `position:absolute; 19.2rem×10.8rem`，里面 `steam__outcome` / `steam__rounds` / `steam__when`
   **全是 absolute 固定坐标**。普通流内元素夹在中间会被盖住。
   现在 `.steam__nodehint` 自己绝对定位到**舞台顶部居中**，`z-index:3`、`pointer-events:none`。
   实测：439×24、`top=16px`、与底部元素**无重叠**。
4. **对局中照样弹**（维护者 2026-10-31 报的「打一半跳出来一条刷新提示」）→
   `connBanner.js` 原来**没有任何「对局中不显示」的判断**，注释写着有、代码里没有。
   现在统一由 `updateHintAllowed` 把关，规则见上表。

##### ⚠ `inMatch` 与「提示显示」是两件事，别混

| 问题 | 由谁回答 | 现在的行为 |
|---|---|---|
| 要不要**自动刷新**页面 | `buildGuard` 的 `inMatch`（`selectRoute === 'game'`） | 对局中 `true` → 绝不自动刷新；变成 `RESULT` 后路由不再是 `game` → 自动刷新一次 |
| 要不要**显示**刷新提示 | `updateHintAllowed(route, phase)` | 大厅 / 房间 / `RESULT` 显示；其余对局阶段不显示 |

维护者要的只是「别在中途弹提示」，**不是**「别在中途换版本」——
所以本次改动没有动 `inMatch` 那套自动刷新逻辑。

##### 横幅位置：所有界面统一在**顶部居中**

`.conn-banner` 原来是 `bottom: .24rem`（大厅在底部），对局中由 `.sp-in-match` 覆写成顶部。
2026-10-31 统一成 `top: calc(1.34rem + var(--sa-t))`、`bottom: auto`。

选顶部而不是底部：对局底部被「战斗视图切换器 + 商店栏」占着，大厅底部可能压到页脚。
实测大厅 / 房间 / 对局三者 `top` 都是 94px、水平中心都在视口中心。

顺带：`.sp-conn .toast-host` 让 toast 在横幅可见时下移，避免常驻横幅与多行 toast 叠在一起。

#### 自查命令

```powershell
# 1) 逐节点 cookie 粘性：30 个必须全部落回自己（任何一个不对 = 那台会掉大厅）
1..30 | ForEach-Object {
  $n = $_
  $h = curl.exe -k -s -o NUL -D - -H "Cookie: sp_route=$n" https://127.0.0.1/ 2>&1
  $got = ($h | Select-String '^X-SP-Node:\s*(\d+)').Matches.Groups[1].Value
  if ($got -ne "$n") { "✗ node-$n 变成了 $got" }
}

# 2) 新访客不能落到旧代码节点（旧代码节点号看 /api/ops/state 的 stale）
# 3) 完整验证（需 Chrome/Edge）：
cd repo-sync
$env:SP_E2E_BASE='https://127.0.0.1'; $env:SP_ROOT='D:\Stronghold-Protocol'
node tools\e2e-refresh-on-stale.mjs     # 旧代码节点上刷新仍在房间
node tools\e2e-node-code-hint.mjs       # 结算页提示只在旧代码节点出现
```

> ⚠ 建 e2e 脚本时注意：登录验证码是**每个字符一个 `<text>` 元素**（实测 4 个），
> 用 `/<text[^>]*>([^<]+)<\/text>/` 的 `exec` 只会拿到第一个字符，登录必然 `captcha_wrong`。
> 要用 `matchAll` 拼起来。`tools/e2e-refresh-room.mjs` 里就有这个 bug（偶尔碰巧能过）。

### 9.34b 只有「正开着对局」的人才被 cookie 粘在旧代码节点上（2026-10-31）

#### 要解决的问题

`sp_route` cookie 的有效期是 **30 天**（`Max-Age=2592000`）。一个节点重启到新代码后不再接新玩家，
可是**手上留着老 cookie 的人**会被一直钉在那台上 —— 哪怕他根本不在对局里。

实测证据：node-6 在 10-31 凌晨还是旧代码，当天早上进它的 **5 个新房全部是 10:09–11:15 之间**
由老 cookie 进来的，没有一个是新分配。这些人以为自己「换了个服务器」，其实只是被 30 天前
的一次分配锁住了。

维护者的要求（2026-10-31 原话）：
> 确认可以改成只有在**玩**的玩家可以被 cookie 粘住，其他的旧玩家不能被关闭的节点粘住 cookie。

#### 现在的规则

`nginx/conf/nginx.conf` 的 `location /` 里，判断顺序是：

```nginx
set $sp_sticky 0;
if ($cookie_sp_sticky = $cookie_sp_route) { set $sp_sticky 1; }   # 值必须与 sp_route 一致
if ($cookie_sp_sticky !~ "^([1-9]|[12][0-9]|30)$") { set $sp_sticky 0; }
set $sp_old 0;
if ($sp_cookie_accepts_new = 0) { set $sp_old 1; }                # cookie 指向旧代码节点
set $sp_final_open $sp_cookie_open;
if ($sp_old = 1) { set $sp_final_open $sp_sticky; }
set $sp_dispatch 1;
if ($sp_is_document = 1) { set $sp_dispatch $sp_final_open; }     # 只对 HTML 文档改派
if ($sp_dispatch = 0) { set $sp_node $sp_rand_node; }
if ($sp_final_open = 1) { set $sp_node $cookie_sp_route; }
```

| cookie 情况 | 落点 |
|---|---|
| `sp_route=6`（node-6 旧代码），**无** `sp_sticky` | 改派到随机新代码节点 ✓ |
| `sp_route=6` + `sp_sticky=6`（真在对局） | 留在 node-6 ✓ |
| `sp_route=6` + `?room=CODE`（带房间码回对局） | 留在 node-6 ✓ |
| `sp_route=6` + `sp_sticky=27`（不一致） | 改派 ✓（实测过，早期版本会误粘） |
| `sp_route=7`（新代码） | 留在 node-7，`sp_sticky` 无关 |
| `/healthz`、`/js`、`/data`、WebSocket | **一律留在页面那台**，不受改派影响 |

#### 维护者的问题：已关闭对外（跑旧代码）的节点上，玩家刷新会不会掉出对局？

**不会**，前提是 `sp_sticky` 还在。三条路任一条成立就留住：

1. 对局中刷新首屏 → 有 `sp_sticky` → 留在原节点；
2. 带 `?room=CODE` 回房间 → **房间码本身就证明在回对局**，比 `sp_sticky` 优先；
3. WebSocket 重连 / `/healthz` / `/data` → 本来就不参与改派。

实测（node-6 当时是唯一旧代码节点，每种连续 10 次）：

```
带 ?room=ABCD         → 6 6 6 6 6 6 6 6 6 6   10/10 回 node-6
不带（不在对局）      → 30 26 19 26 12 22 …    10/10 改派走
对局中（sticky=6）    → 6 6 6 6 6 6 6 6 6 6   10/10 留在 node-6
```

真机验证：在旧代码节点上建房开打，**对局中连续刷新 3 次**，每次 `node`、`room`、`route`
三者都不变（仍在原节点、原房间、仍在对局）。

> ⚠ **`?room=` 那条曾经被我改坏过。** 第一版把改派判断放在 `?room=` 赋值之前，
> 于是带房间码刷新会被赶走。现在的顺序是：
> `$sp_is_document` 先算 → **后面再判一次 `$arg_room` 覆盖回 1** → 才改派。
> 改这段时务必保持「`?room=` 的判断在 `$sp_is_document` 之后」。

#### 为什么 `sp_sticky` 要 30 秒续期一次

`sp_sticky` 一旦消失（浏览器清理、长时间挂机、某些隐私设置），下一次刷新就会被改派走。
所以 `ui/stickyNode.js` 在对局期间每 30 秒重写一次 cookie（`Max-Age` 7 天）。
代价是每分钟一次 `document.cookie` 写入，可以忽略；换来的是「对局期间绝不掉线」。
离开对局立刻停表并删除 cookie。

#### `sp_sticky` 由谁写

只能由**前端**写 —— nginx 是「看 cookie 做决定」的一端，它没法自己知道这个人是不是在打对局。

`public/js/ui/stickyNode.js`：

- `selectRoute(store.get()) === 'game'`（即 `match.public.phase ≠ LOBBY` 或 `room.inMatch`）
  → 写入 `sp_sticky=<sp_node cookie 的值>`，`Max-Age` 7 天
- 离开对局 / 回到大厅 → **立刻删掉**
- 页面刚打开时如果不在对局 → 也删掉（清掉上一次会话的残留）
- 拿不到 `sp_node` 就**不写**：猜一个节点写进去比不写更糟（会把人在错误的节点上钉死）
- 对局期间**每 30 秒续期一次**（见上一节），离开对局即停表 + 删除

已在 `public/js/main.js` 里 `startStickyNode(store, { selectRoute })` 启动；
admin 观战页不启动（观战者本来就不在对局里，写了反而把观战页钉在旧节点上）。

#### 踩过的坑（都实测确认过）

1. **`map` 出来的变量是只读的。** `$sp_cookie_open` 来自 `map`，对它 `set` 会**被静默忽略** ——
   不报错、`nginx -t` 也通过。第一版就是直接 `set $sp_cookie_open $sp_sticky;`，
   看起来改派了，实测一个都没生效，白测半天。必须另开可写变量（这里是 `$sp_final_open`）。
2. **`add_header` 的值是空串时，nginx 照样输出这个头。** 第一版把 `Set-Cookie` 的默认值给了空串，
   于是 `/healthz` 返回 `Set-Cookie: sp_route=; Max-Age=2592000` —— 浏览器把玩家的 `sp_route`
   清空，**每打一次健康检查就把人踢下节点**。默认值必须是 `$sp_node`（幂等写回当前节点）。
3. **`if` 块里的 `add_header` 会让外层所有 `add_header` 失效**（nginx 的按块继承规则）。
   `/healthz` 的 `X-SP-Node`、`X-SP-Accepts-New` 因此**一直是缺失的**，直到这次才修。
   解法：`if` 块里只 `set` 变量，`add_header` 全部留在外层。
4. **`if` 按书写顺序执行。** 先算完 `$sp_final_open` 才能拿它改派，顺序错了就是静默无效。
5. **没初始化的变量读出来是空串，空串不等于 0。** `$sp_dispatch` 必须先 `set 1`，
   否则「不改派」这个行为是靠巧合成立的。
6. **`tools/sync-open-nodes.ps1 -Apply` 会因「配置无变化」短路，即使改的是 `nginx.conf` 本身。**
   加 `-Force` 强制 reload（已修：`-Force` 现在真的能绕过短路）。

#### 自查命令

```powershell
# 核心矩阵（node-6 / node-30 是当前旧代码节点，实际节点号看 sync-open-nodes.ps1 输出）
1..30 | ForEach-Object {
  $n = $_
  # (a) 无 sticky → 必须不在旧代码节点上
  $h1 = curl.exe -k -s -o NUL -D - -H "Cookie: sp_route=$n" -H "Accept: text/html" https://127.0.0.1/
  $a1 = ($h1 | Select-String '^X-SP-Node:\s*(\d+)').Matches.Groups[1].Value
  # (b) 有对应的 sticky → 必须落回自己
  $h2 = curl.exe -k -s -o NUL -D - -H "Cookie: sp_route=$n; sp_sticky=$n" -H "Accept: text/html" https://127.0.0.1/
  $a2 = ($h2 | Select-String '^X-SP-Node:\s*(\d+)').Matches.Groups[1].Value
  if ($a2 -ne "$n") { "✗ node-$n sticky 没粘住，变成 $a2" }
}

# /healthz 绝不能清 cookie（看有没有 Set-Cookie: sp_route=;）
curl.exe -k -s -o NUL -D - -H "Cookie: sp_route=6" https://127.0.0.1/healthz | Select-String 'Set-Cookie'
```

单元测试：`cd repo-sync && node --test test/ui/stickyNode.test.js`（8 项）。

---

### 9.34c 管理员工具只能在自己参与的对局里打开（2026-10-31）

维护者的规则：
> 设置成观战和隐身观战时不能打开管理员工具。只有在自己游玩对局中才可以。

#### 判据（唯一一处实现：`public/js/ui/adminGate.js`）

`canOpenAdminTools(store.get())` 必须**全部满足**才返回 true：

| # | 条件 | 不满足的例子 |
|---|---|---|
| ① | `adminId === true` | 普通玩家、以及「登录了但不是 owner/admin」 |
| ② | `match.public` 存在 | 大厅、房间等待室里（还没开局） |
| ③ | 有 `room` 且知道自己的 `playerId` | 状态未就绪 |
| ④ | `room.spectators` 里**没有**自己 | **普通观战、隐身观战** |
| ⑤ | `room.seats` 里**有**自己 | 没席位却在对局里 = 在看别人打 |

④ 是最关键的一条：隐身观战（`?adminWatch=1&adminNode=N`）会把管理员加进 `room.spectators`，
所以它和普通观战走同一个判据，不需要单独识别。

#### 两道拦截，缺一不可

1. **点击层**：`mm/client.js` 的节点状态胶囊 click 里判 `canOpenAdminTools` 才派发事件。
   ⚠ `mm/client.js` 是注入的 IIFE，**import 不了 ES 模块**，又要同步判断，
   所以那里有一份**等价副本**。改判据时两边都要改 ——
   `test/ui/adminGate.test.js` 的最后一条测试会去源码里核对四条条件是否还在。
2. **事件层**：`public/js/ui/hud.js` 监听 `sp-open-admin-tools` 时**再判一次**。
   派发方已经挡了一层，但如果被绕过（或有人手动 `dispatchEvent`），这是唯一防线。

#### 为什么不用「观战者在 seats 里」来放行

换座位的瞬间可能出现「既在 seats 又在 spectators」的状态。
这时**按观战处理**（拒绝）—— 保守一侧永远不会让不该改场子的人改到别人的局。

#### 已验证（真实浏览器 + 真实模块）

| 场景 | 判据 | 面板 |
|---|---|---|
| 管理员在大厅 | false | 不出现 |
| 管理员在房间里（未开局） | false | 不出现 |
| **管理员在自己参与的对局中** | **true** | **出现**（`.admintools-host` innerHTML 708 字节） |
| 同一局里被标记成观战者 | false | 不出现（len 0） |

单元测试：`cd repo-sync && node --test test/ui/adminGate.test.js`（12 项）。

#### ★ 三道门：身份 / 权限 / 验码（2026-10-31 定稿）

上面 ①–⑤ 是「**在哪能点开**」。真正能不能用工具，还要过三道门，缺一不可：

| 门 | 字段（`welcome` 下发） | 判据 | 谁能过 |
|---|---|---|---|
| ① 身份门 | `adminId` | 账号 `role in (owner, admin)` | 管理员账号 |
| ② **权限门** | `gameTool` | 后台 `admin_perms` 里有 `tools.game` | owner 恒真；普通 admin 看权限表 |
| ③ 验码门 | `adminCode` | 手里有未过期、未被吊销的验码令牌 | 兑换过授权码的人 |

前端在 `adminGate.js` 里判 `adminId && gameTool`（**身份+权限**），
`adminTools.js` 组件内再判一次 `if (!adminId || !gameTool) return null`。
**没有权限的 admin 连取码框都看不到** —— 维护者明确要求「没权限不能打开授权界面」。

`gameTool` 是怎么到节点的：matchmaker 查库判定（`gameToolAllowed()`），
写进 `userToken` 的 `gameTool` 字段，节点 `readUserToken()` 读出来 → `session.gameTool` → `welcome.gameTool`。
节点只验签、不查库，所以必须这样带过去。

> ⚠ **旧令牌没有 `gameTool` 字段，一律按 `false` 处理**（保守）。
> 改了权限逻辑或升级后，管理员需要**退出账号重新登录一次**才有这个字段。
> 现场表现：管理员工具入口完全不出现，刷新也没用 —— 先查 `welcome.gameTool` 在不在。

##### 验码门的三条硬规则

1. **授权码只能被生成它的管理员本人兑换。**
   兑换身份**只取自登录会话**（`currentUser(req)`），请求体里的 `email` 一律不采信；
   另外再比对一次 `rec.uid === me.id`。
   篡改请求体塞别人的邮箱 → `403 not_your_code`；未登录 → `401 login_required`。
2. **有效期 4 小时，到点自动退回取码界面。**
   有效期由服务端 `adminToolTtlMs()` 决定，随兑换响应回 `ttlMs`，前端不再写死 4 小时。
   到点时前端会**清掉 `window.__SP_ADMIN_TOKEN` / `sessionStorage` / `sp.adminCodeExp` 并重连** ——
   只改一个布尔值是不够的，那样「面板退回了但手里还攥着旧令牌」。
   模块加载时也会先判过期，过期就不恢复令牌。
3. **兑换 / 退出授权都**不刷新页面**。**
   `net.rehandshake()` 在同一条连接上重发 hello，服务端重算后通过 `welcome` 把
   `adminCode` / `adminTools` 推下来，界面自己就切了。
   实测：兑换前 false/false → 兑换后 true/true → 退出后 false/false，
   `Page.frameNavigated` 计数全程 1（零刷新）。

##### 测试有效期用的开关

```powershell
$env:SP_ADMIN_TOOL_TTL_MS='60000'      # 1 分钟
pm2 restart matchmaker --update-env
# 验证完务必改回来（不设 = 4 小时），并确认 pm2 env 里已经没有这个变量：
pm2 env <matchmaker-id> | Select-String SP_ADMIN_TOOL_TTL_MS
```

> ⚠ pm2 会记住这个变量，`pm2 restart` 清不掉；要显式 `Remove-Item Env:\SP_ADMIN_TOOL_TTL_MS`
> 再 `pm2 restart matchmaker --update-env`。确认兑换响应里 `ttlMs: 14400000` 才算恢复。

##### 曾经踩过的坑

| 坑 | 后果 |
|---|---|
| `adminTokenFor()` 签的令牌没有 `iat` | 点过一次「退出授权」后，账号登录带来的令牌**永久**失效（`verifyAdminToken` 把无 `iat` 的令牌全废）。刷新也没用 |
| `/api/auth/me`、登录、改名都顺手发 `adminToken` | 「登录管理员账号」= 「工具直接可用」，验码门形同虚设 |
| 兑换后 `location.reload()`，令牌只在内存 | 一刷新就丢，而码 10 分钟就过期 —— 等于白换 |
| `verifyAdminToken` 不比对 uid | 普通玩家塞进别人的 owner 令牌会得到 `adminCode=true`（功能仍被拒，但界面显示错状态） |
| `seat.admin` 直接读 `session.admin`（三道门全过） | 没兑换码的 owner 在控制台被显示成「玩家」。**徽章 = 身份+权限**，不是「此刻能不能改数据」 |
| 只有 `startMatch` 算 `ps.admin` | 对局中才兑换授权码的人，`g.test` 一直被拒、甚至崩（`_testRate` 没初始化）。已在 `onHello` 同步 |

---

### 9.34d 防消极游戏（2026-10-31）

维护者的规则（分四次提出，合并成现在这一套）：

> 消极游戏自动踢出；被踢的人本局不能自己加回来；
> **单人（不足 2 个真人）不判定**；挂机 4 分钟也踢。

#### ★ 先说最重要的一课：这套机制原本就有，但**从来没生效过**

`MatchIntents._trackActivity()` 里早就写了两条规则，`server/lobby.js` 也写了 `kickIdle()`。
但创建 Match 时**没传 `onIdleKick` 回调**，于是：

```js
this.onIdleKick?.(ps.playerId, 'idle');   // 可选链吞掉，永远不执行
```

结果：**只弹一个 toast，人照样留在局里**。而且这个 bug 静默了不知道多久 ——
没有报错、没有日志，界面还"正常提示"了，只有去读 `ps.admin` / 查代码才发现。

> **教训：写「回调式」扩展点时，一定要检查调用方是否真的接线。**
> `?.` 会把漏接线变成静默失败。
> `patcher/new/server/lobby.js:1480` 里本来有这行接线，升级时漏合并到了
> `server/lobby.js` —— 这也是「补丁完整性」检查之外，需要人工复检的一类漂移。

#### 现在的完整规则

**对局中**（`_trackActivity`，只在第 1–4 回合判定）：

| 规则 | 条件 | 动作 |
|---|---|---|
| 一 | 连续 2 回合**花钱**（买/刷新/升级）却**一次没部署** | 踢出 |
| 二 | 连续 2 回合**既不购买也不部署** | 踢出 |

不判定的情况（**全都必须满足才判**）：

- **真人数量 < 2** —— 单人局（一真人 + 任意 AI 都算单人）
- 第 4 回合之后（中后期踢人会让整局失衡）
- AI 座位
- 已经被踢过的（`ps._idleKicked` 标记）

**房间里**（`sweepIdle` + `idleKickMs`，默认 **4 分钟**）：

- 坐着、**没点准备**、连接着、4 分钟没有任何消息 → 移出
- 已点准备的 / AI / 断线的**不算**（断线另有 15 分钟重连窗口）
- `session.lastActiveAt` 在 `onMessage()` 开头刷新，所以**任何操作都算活跃**

#### 两个容易写错的细节

1. **不能用 `this.loneHuman` 判单人。** 它是**建局时**的一次性快照。
   「2 人开局、中场退了一个」之后它就过期了 —— 那时其实已经是单人局，
   再按消极踢剩下那一个人是不合理的。现在用 `_humanCount()` **每次实时数**：
   `this.order` 里 `!isBot && !left` 的数量。
2. **被踢后要留记录，否则他立刻能加回来。**
   记录放在 `room.idleKicked`（`Map<accountId, {...}>`），
   `join()` 一开始就查，命中回 `ERR.IDLE_KICKED`（「你因消极游戏被移出本局，本局不能自己加回来」）。

   - 按 **`accountId`** 记，不按 `playerId` —— 重连会换 `playerId`，按它记等于没记。
   - 记录**挂在房间上**：房间散了就一起没，不会「被踢一次、以后永远进不了这个房」。
     换新房间（新开局）也不受影响。
   - 没有 `accountId` 的游客无法追踪，只照常移除、不记录（不崩）。

#### 相关文件

| 文件 | 职责 |
|---|---|
| `server/match/match/intents.js` | `_trackActivity`（两条规则）、`_humanCount()`、`ps._idleKicked` |
| `server/lobby.js` | `kickIdle()`、`sweepIdle()`、`idleKickMs`、`onIdleKick` 接线、`room.idleKicked` 与 `join()` 的拦截 |
| `shared/constants.js` | `ERR.IDLE_KICKED` + 文案 |
| `server/match/Match.js` | `_testRate` / `testLog` / `testTimers` 的初始化（原来只在建局有管理员座位时建，对局中兑换授权码会崩，已在 `applyTestCommand` 里按需补齐） |

#### 自查命令

```powershell
cd repo-sync
node --test test/match/idle-guard.test.js       # 10 项：两条规则/单人豁免/退到1人/不重复踢/AI
node --test test/match/idle-no-rejoin.test.js   # 5 项：按账号拦/换 playerId 拦不住/别人不受影响/换房能进
```

> ⚠ 测试环境 `data/create-room.json` 是 `{"enabled":false}`（建房维护开关），
> `lobby.create` 会回 `CREATE_DISABLED`。测试里给 session 加 `admin: true` 借道建房
> （代码里管理员无视维护开关），这与被踢判定无关。
> 另外 `fail()` 返回的是 `{ error }`，**没有 `ok` 字段** —— 断言要用 `error`，别写 `ok === false`。

---

### 9.34e 今天顺手修的几处小的（2026-10-31）

#### 后台「生成验证码」的字太小

`matchmaker/public/admin.html` 里这一行写了**两个 `style` 属性**：

```html
<code id="toolCodeOut" style="font-family:monospace;..." style="font-size:20px;color:#9ff0d8"></code>
```

HTML 同一标签的重复属性，浏览器**只认第一个**，第二个整个丢弃 ——
于是 6 位码一直是默认 12px + 全局 `code{color:#f0c674}` 的黄色。
改成在 `<style>` 里用 `#toolCodeOut{...}`（28px、薄荷绿、加粗、带字距），
另外加了 `:empty{display:none}`（没生成码时不占空框）和 `[data-state="used"]` 变灰。

> **教训：HTML 里重复属性是静默失败的**，不报错、不警告，只有肉眼看样式才发现。
> 改这类单行内联样式时，先 `Select-String 'style="'` 数一下同一行有没有两个。

#### 有观战按钮时，节点状态胶囊会左右位移

对局顶栏容器是 `topbar__left`（flex + `gap:10px`）。节点状态胶囊插在**延迟胶囊后面**，
而游戏本体的观战胶囊（`SpectatorPill`）**也渲染在延迟胶囊后面** —— 两者抢位置，
观战者一出现节点状态被推右 34px（实测 `left 199 → 233`），归零又弹回来。

修法（`mm/client.js` 的 `place()`）：

1. 每次把观战胶囊挪到**节点状态之后**，节点状态的位置就只由延迟胶囊宽度决定；
2. 节点状态自身 `margin-left` 清零（间距交给容器 `gap`）——
   原来 `margin:10px` 叠加 `gap:10px`，会让 `left` 在 165/167 之间跳 2px；
3. 补 `flex: 0 0 auto`，避免被 flex 伸缩带着走。

实测：反复插拔观战胶囊 6 次，`delta` 全部为 0。
（`before` 值在 165~175 之间浮动是延迟数字宽度变化，与观战无关。）

#### `tools/sync-open-nodes.ps1` 的 `-Force` 曾经是假的

脚本里声明了 `[switch]$Force`，但「配置无变化」的短路判断在它之前就 `exit 0` 了 ——
于是**改了 `nginx.conf` 本身**（`open-nodes.conf` 没变）跑 `-Apply`，会被当成"没变化"跳过，
新配置**一直不上线**。已改成 `if ($oldContent -eq $newContent -and -not $Force)`。

另外仓库里的这份脚本一度落后于部署目录（缺 `$EXCLUDE` 保留名单），已同步。

#### 部署脚本的分发范围

`deploy/sync-nodes.cjs` 的 `DIRS = ['public','shared','server','plugins','packs','schemas']` ——
**`public/` 在里面**，所以 `public/js`、`public/css` 的改动要跑一次 `--apply` 分发到 30 台。
（但改完不用重启节点：静态文件玩家刷新即可。）

---

### 9.35 含中文的 `.ps1` 必须带 UTF-8 BOM（2026-10-31 踩到）

PowerShell 5.1 **无 BOM 时按 GBK 解析脚本**，含中文的脚本会直接解析失败：

```
Missing closing '}' in statement block or type definition.
Unexpected token ')' in expression or statement.
└─ 提示的行号还指向别的地方，看不出来是编码问题
```

当天 `tools/sync-open-nodes.ps1` 在给输出加注释后变成无 BOM，**每 5 分钟的自动同步整条挂掉**，
而且计划任务只报 `Last Result: 1`，不看脚本输出根本不知道原因。

写入时显式带 BOM：

```powershell
$enc = New-Object System.Text.UTF8Encoding($true)   # $true = 带 BOM
[System.IO.File]::WriteAllText($path, $content, $enc)
```

检查：

```powershell
$b = [System.IO.File]::ReadAllBytes($path)[0..2]
if ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { '✓ 有 BOM' } else { '✗ 无 BOM' }
```

> 用 `Out-File -Encoding UTF8` / `Set-Content -Encoding UTF8` 在 **PowerShell 7** 下**不加** BOM，
> 在 5.1 下会加。两种都可能踩到，所以不要依赖 cmdlet 的默认行为，一律显式写字节。

#### 连带问题：被 dashboard 调用时中文变乱码

`powershell.exe` 作为子进程时 stdout 是管道，默认按控制台代码页（中文系统 = GBK/936）输出，
而 `dashboard/server.js` 按 UTF-8 读 → 面板上显示成 `ڵ�̽��: ��� 30`。

修法是在脚本开头强制管道输出用 UTF-8（已加进 `sync-open-nodes.ps1`）：

```powershell
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
```

注意日志文件本身一直是正确的 UTF-8——**只有管道那段错了**，
所以别因为面板显示乱码就去改 `Out-File -Encoding UTF8`。


#### ⚠ 踩过的坑：pm2 的 ecosystem 路径必须写绝对路径

整合当天，面板点「重启空闲节点」后显示：

```
已重启 1 个: 8
[PM2][ERROR] File ecosystem.config.cjs not found
```

**一行字两个错**：

1. **`ecosystem.config.cjs` 是相对路径** —— pm2 相对**调用进程的 cwd** 找文件。
   dashboard 被 pm2 从别的目录拉起，cwd 不是部署根，于是根本找不到。
   后果是 `startOrReload` 什么都没做，**节点重启失败**。
2. **失败却报「已重启」** —— 结果里 `notify` 那行是硬编码的成功文案，
   没看 pm2 的退出码/输出。维护者以为自己点成功了，实际一个节点都没动。

正确写法（`dashboard/server.js` 与 `deploy/ops-menu.ps1` 都已改）：

```js
const eco = path.join(BASE, 'ecosystem.config.cjs');          // 绝对路径
execFile(process.execPath, [PM2_JS, 'startOrReload', eco, '--only', names, '--update-env'],
  { cwd: BASE }, (err, out, errOut) => {
    if (err || /\[PM2\]\[ERROR\]/.test(out)) { /* 报失败，且【不要】pm2 save */ }
  });
```

**三条通用规则**（以后再写运维脚本都适用）：

- 调 pm2 一律：**绝对路径的 ecosystem + 显式 `cwd` + 检查退出码/`[PM2][ERROR]`**；
- **失败时不要 `pm2 save`** —— 那会把一个可能不对的进程表固化下来；
- 重启后要**复查**：节点响应了吗？`fresh` 变 true 了吗？没起来就必须报出来，
  不能只说「已重启」。

> 当天实测：点出这个错误的是一次针对 node-8 的误点，但 node-8 **实际没有重启**
> （`uptime` 仍是 8000+ 秒、`matches` 也没断），所以没有玩家受影响 —— 因为
> `startOrReload` 在报错前就退出了。这也说明「报错时绝不能显示成功」有多重要。

### 9.12 玩家反馈「一直在重启」——2026-10-28 连环事故

> 维护者原话：「玩家反馈一直在重启，你看看你改了什么」

当天下午连续修了三轮，每一轮都以为找到根因了，下一轮又冒出来。
**根因是一条链：两个服务抢同一个端口 → 一个无限崩溃循环 → 看门狗读不到状态就全量重启。**

#### 症状与定位方法（下次照着走）

| 要确认的事 | 怎么看 | 判据 |
|---|---|---|
| 服务端到底有没有重启 | `healthz` 的 `uptimeSec`；或 `logs\restart-watch.log` | 运行时长**变小** = 重启过 |
| pm2 有没有重启过某个应用 | `pm2 jlist` 的 `restart_time` | 计数字段只增不减，看它有没有涨 |
| PM2 里有没有崩溃循环的应用 | `pm2 jlist` 里 `status` 不是 `online` 的 | `errbackoff`/`waiting restart` = 崩溃循环 |
| 谁在动进程 | `logs\pm2-resurrect.log`、`logs\stack-watchdog.log` | 出现 `start node-XX` / `resurrect` 就是它 |

**最有用的一条**：`restart_time` 几百上千次 = 有个应用在崩溃循环，别去别处找。

#### 第 1 环：`nginx-gateway` 崩溃循环 4321 次

为了满足「nginx 不能挂在用户会话下」，2026-10-27 把 nginx 改成由计划任务
`SP-Nginx-Start` 以 SYSTEM 身份启动，**但没有停掉 pm2 里的 `nginx-gateway`**
（它本是原作者设计用来托管 nginx 的 wrapper，跑 `nginx\run-nginx.mjs`）。

结果两个都想占 443：

```
SP-Nginx-Start (SYSTEM) → 占用 443 ✅
nginx-gateway (pm2)     → bind 失败 → autorestart 重试 → 失败 → …
                          实测崩溃 4321 次
```

**修法**：`pm2 delete nginx-gateway`，并从 `ecosystem.config.cjs` 删掉定义
（只停进程不够 —— `resurrect` 会把它拉回来）。代码里留了注释说明**不要加回去**。

#### 第 2 环：看门狗读不到 pm2 状态 → `resurrect` 全量重启

`deploy\_stack-watchdog.ps1` 原来的逻辑：

```powershell
cmd /c "pm2 jlist > tmp 2>nul"     # 失败静默返回空
$online = @($r.out -split ',')     # 空
$missing = $expected 里不在 $online 的  # → 全部 32 个都"缺失"
pm2 resurrect                       # ← 重启整张进程表
```

`pm2 jlist` 在 pm2 忙时会**间歇性失败**。一次读取抖动 → 判定「所有应用都丢了」→
`resurrect` → 全服重启。日志里 `ALERT cannot read PM2 status` 从 11:52 刷到 13:40
就是这个过程。**实测一次这样的误判中断了 10 局对局。**

`_start-pm2.ps1` 有同样的形状（`$online` 空 → 全部缺失 → 逐个 `start --only`），
只是没那么狠。

**修法（两条脚本都改了）**：

1. 读不到 / 明显过短 → **这一轮什么都不做**，只记日志
2. `_stack-watchdog` **连读两次且必须一致**才采信（正在变动时不猜）
3. 缺失过半 → 认定是读数问题，不动进程
4. **永不 `resurrect`** 去补缺失的应用，只对确实缺的逐个 `--only` 启动
   （`resurrect` 只保留给「pm2 守护进程整个挂了」，那时所有应用本来就都没了）

#### 第 3 环：我自己那次 `pm2 delete` 也触发了全量重启

13:12 执行 `pm2 delete nginx-gateway` 时，30 个节点在 2 分钟内挨个重启，中断 10 局。

**教训**：`pm2 delete` 会重排进程表。要摘掉一个应用，**低峰期做**，
并且事前先用 `restart-watch` 或手动采样确认在线的对局数。

#### 这次的深层教训

| 教训 | 说明 |
|---|---|
| **改启动方式 ≠ 只改启动方式** | 把 nginx 从 pm2 挪到计划任务，只做了一半（改了新的，没停旧的）。凡涉及「谁托管这个进程」，必须**先停旧的再起新的**，或两者互斥 |
| **看门狗的「读不到」绝不能被当成「都没有了」** | 这是本事故最危险的一条。任何「检测 → 修复」型脚本，第一件事都是**区分「真的坏了」和「我读不到」** |
| **`resurrect` 是高危操作** | 它按保存的进程表重启**全部**应用。只应在「整栈都没了」时用，绝不能当作「补几个缺失应用」的手段 |
| **修复要能自证** | 每轮改完都要用运行时长/`restart_time` 验证，而不是看日志里没有报错就收工 |

#### 现在的状态（2026-10-28 14:00）

- nginx：计划任务 `SP-Nginx-Start` 启动，3 进程全部 Session 0
- pm2：32 个应用，`nginx-gateway` 已移除
- 崩溃恢复：`_stack-watchdog.ps1` 每 2 分钟，只补确实缺的；nginx 没了会经计划任务拉起
- **巡检**：计划任务 `SP-Restart-Watch` 每 10 分钟跑 `deploy\restart-watch.ps1`，
  比对运行时长，发现变小就写 `logs\restart-watch.log` 的 `RESTART DETECTED`
  （后续再排查直接看这个日志，不必靠人盯着）

```powershell
# 手动看一眼巡检结果
Get-Content D:\Stronghold-Protocol\logs\restart-watch.log -Tail 20
# 正常是连续的 ok，形如：
# 2026-10-28 13:57:58 ok alive=30/30 avg_uptime=784s
```

### 9.21 「恢复对局」按钮只在大厅、且挨着「公告」（2026-10-29 修正）

玩家反馈：恢复对局按钮的位置不对，希望它在大厅「公告」按钮旁边；
维护者进一步明确：**其他界面均不要出现恢复对局按钮**。

#### 原来的位置没写错，但按钮会跑到别处去

代码里的插入是 `insertBefore(btn, anchor)`，锚点就是「公告」按钮 ——
所以**只要锚点找得到，位置本来就在公告左边**（维护者 2026-10-29 确认要左边）。

问题出在**锚点找不到时的降级链**：

```js
const anchor = notice
  || document.querySelector('.verchip-wrap, button.verchip[data-testid="version-switch"]')
  || [...document.querySelectorAll('button')].find((b) => /S\.W\.E\.E\.P/i.test(...));
if (!anchor || !anchor.parentElement) {
  // 造一个 position:fixed 的按钮挂在 body 上
}
```

三种情况会把按钮放到不是「公告旁边」的地方：

| 情况 | 结果 |
|---|---|
| 大厅里公告按钮还没渲染出来 | 退到**版本按钮**旁边（位置变了） |
| 版本按钮也没有 | 退到 **S.W.E.E.P. 文字按钮**旁边 |
| 三个都没有 | **右下角浮动按钮**，任何界面都挂着 |

第三条最糟：玩家在对局中、结算页、设置页都能看到右下角冒出来一个「恢复对局」，
而那根本不是大厅。

#### 修复：只认公告按钮，拿不到就不显示

```js
/** 大厅的「公告」按钮此刻是否真的可见 */
const lobbyNotice = () => {
  const n = document.getElementById('mm-notice-btn');
  if (!n || !n.isConnected) return null;
  if (n.style.display === 'none') return null;                       // 非大厅被 ensureTopButton 隐藏
  if (n.getClientRects().length === 0) return null;                  // 不可见（display/尺寸为 0）
  return n;
};

if (!lobbyNotice()) { removeBtn(); return; }        // 不在大厅 → 直接没有任何按钮
const anchor = lobbyNotice();                        // 锚点只认公告
```

**为什么用「公告按钮是否可见」当作「是否在大厅」的判据**：
`ensureTopButton`（公告按钮的维护函数）在非大厅界面会把它 `display:none` 并返回 null，
所以不管界面怎么改版、路由怎么变，**只要玩家不在大厅，公告按钮就不在**，
恢复对局自然也不会冒出来。这比判断屏幕类名/路由更抗改版。

同时**删掉了整段浮动按钮降级**（`mm-resume-fallback`）—— 它正是「其他界面也出现
恢复对局」的源头。

#### 生效方式

`client.js` 由 nginx 的 `sub_filter` 注入，**改完必须改版本号**：

```
client.js?v=20261029-1  →  client.js?v=20261029-2
```

**需重启 nginx**（`node tools/restart-nginx.mjs --apply`）。

#### 补丁副本怎么改的（吸取上次教训）

两个补丁（`client-announcement` / `matching-party`）的 `client.js` 内容各不相同，
**不能整份覆盖** —— 上次整份覆盖就把 `server/lobby.js` 误写进了前端文件（§9.19 末尾）。
这次用脚本按**精确字符串**分三段替换，替换后逐段校验命中数（3/3）：

1. 抽出 `lobbyNotice()` / `recentlyLeft()` 两个辅助函数
2. 删掉浮动按钮降级段
3. 锚点链改成只认公告按钮

### 9.20 观战「席位已满（2/2）」——前端写死了 2（2026-10-29 修复）

玩家反馈：**房间 PCPJ 观战进不来，提示「观战席位已满（2/2）」**。

#### 服务端没问题，是前端把上限写死了

服务端的观战上限是 `server/lobby.js` 的 `spectatorLimit()`：

```js
spectatorLimit() {
  if (this.mode !== 'coop') return 0;
  return Math.max(MAX_SPECTATORS, Math.ceil(this.activeHumans().length / 2));
}
```

**取 `max(2, 玩家数 / 2)`**，“2”只是下限：

| 玩家数 | 观战上限 |
|---|---|
| 1–4 | 2 |
| 5–6 | 3 |
| 8 | 4 |
| **14（PCPJ）** | **7** |
| 20 | 10 |

但 `matchmaker/public/client.js` 的大厅跳转预检把上限**写死成 2**：

```js
if (spec && Number(d.spectators) >= 2) { showStyledToast('观战席位已满（2/2），请稍后再试'); return; }
```

于是**任何房间第 3 个想观战的人都会被前端拦下**，根本不会走到服务端。

#### 实测对照（PCPJ，2026-10-29）

```
find-room 返回: node=8 humans=11 spectators=2 maxSpectators=6 started=False
旧逻辑 (>=2 就拦):            拦下 ✗   ← 玩家看到的就是这个
新逻辑 (>=maxSpectators 才拦): 放行 ✓
```

另外直接用测试账号 `room.spectate PCPJ` 实测，**第 3 个观战者成功进入**：

```
room.state: spec=["逸天","记念","观战测试"]  maxSpectators=7
```

#### 修复

`find-room` 早就已经把权威的 `maxSpectators` 带回来了（`matchmaker/server.js` 的
`roomInfo()`，算法与服务端一致），前端直接用它：

```js
if (spec) {
  const cap = Number.isInteger(d.maxSpectators) ? d.maxSpectators
    : (d.mode === 'coop' ? Math.max(2, Math.ceil((Number(d.humans) || 0) / 2)) : 0);
  const used = Number(d.spectators) || 0;
  if (used >= cap) { showStyledToast(`观战席位已满（${used}/${cap}），请稍后再试`); return; }
}
```

提示里的数字也改成实际值（`已用/上限`），不再永远显示 `2/2`。

#### ⚠ 改 `client.js` 必须同时改 nginx 的版本号

`client.js` 是通过 nginx 的 `sub_filter` 注入的，带版本号：

```nginx
sub_filter '</body>' '<script src="/mm/client.js?v=20261026-107" defer></script>…';
```

**不改这个 `?v=`，浏览器会继续用缓存的旧文件** —— 改了等于没改（§9.x 踩过同样的坑，
当时 `account-title.js` 就是版本号没动导致修复不生效）。

本次已由 `20261026-107` 改为 **`20261029-1`**。

#### ✅ 已生效（2026-10-29 20:51，维护者亲自重启 nginx）

重启过程**零中断**（细节见「重启 nginx」一节 §9 的 2026-10-29 实测）：

```
20:51:26  进程=3  HTTP=200  版本=20261026-107
20:51:29  进程=5  HTTP=200  版本=20261029-1   ← 切换
```

生效后验证：

| 检查 | 结果 |
|---|---|
| 首页注入的版本号 | `client.js?v=20261029-1` ✓ |
| `/mm/client.js?v=20261029-1` | HTTP 200，**含 `d.maxSpectators` 新逻辑** ✓ |
| 残留 `>= 2` 硬编码 | 只剩第 924 行的**注释**（说明改了什么都），代码里已无 ✓ |
| nginx 进程 | 3 个 ✓ |
| 对局 | 重启前 24 场 → 重启后 **26 场**，一场没断 ✓ |

**玩家侧**：刷新页面即可（版本号变了会强制重新下载 `client.js`）。
若玩家仍看到「2/2」，让他 `Ctrl + F5` 一次。


#### 教训

**同一个规则在服务端和前端各写一遍，迟早会不一致。** 遇到「明明没满却提示已满」，
先看前端有没有自己算一遍 —— 这个例子里服务端完全正确，是前端把它盖掉了。

### 9.19 「结束对局」按钮 —— 只结束这一局，房间留着（2026-10-29 新增）

维护者要求：房间表能**单独结束某一局**，但**不销毁房间**。

#### 和「关闭房间」的区别（两个按钮并存，别搞混）

| 按钮 | 走的方法 | 结果 |
|---|---|---|
| **关闭**（原有） | `disposeRoom(room, 'admin-closed')` | 房间整个没了，所有座位/观战者收到 `room.closed`，玩家被移出同盟、回到大厅 |
| **结束对局**（新增） | `abortMatch(room)` | 只这一局结束，**房间、座位、玩家都留着**，可以立刻重新开局 |

两个按钮都只在**房间表里那间房正在对局时**才显示「结束对局」（没有对局时这个按钮没有意义）。

#### 实现要点

`abortMatch` 走的是和对局**自然结束完全一样**的收尾路径 `onMatchEnd`：

```js
abortMatch(room, { reason = 'admin-aborted' } = {}) {
  const ctx = room.matchCtx;
  if (!ctx || !room.match) return { ok: false, reason: 'no_match' };  // 没对局：如实说，不算失败
  this.onMatchEnd(room, ctx, { reason, detail: 'admin', adminAborted: true });
  if (!room.disposed) this.broadcastState(room);
  return { ok: true, code: room.code, wasRunning: true };
}
```

**为什么必须走 `onMatchEnd` 而不是自己清字段**：它会一并处理这些收尾 ——
房间退回大厅（`match/matchCtx/matchKey` 置空）、座位 `ready` 重置、房主迁移、
以及**把「15 分钟未开始对局就解散」的计时推到现在**（`lastMatchEndAt`）。
少做任何一步，都可能出现「结束对局后房间立刻被解散」这类问题（§9.x 踩过一次）。

没有对局时返回 `409 no_match`，前端的文案是「这个房间当前没有进行中的对局」
—— 是**如实说明**，不是报错。

#### 三处改动

| 位置 | 内容 |
|---|---|
| `server/lobby.js` | 新增 `abortMatch(room)` |
| `server/http/routes.js` | 新增 `POST /admin/room/abort`（鉴权与 `/admin/room/close` 完全一致：loopback/内网 + HMAC + 60 秒时限） |
| `dashboard/server.js` | 新增 `POST /api/rooms/abort`；`closeRoom` 与 `abortMatch` 合并到 `adminRoomAction(action, ...)`，只差路径、失败话术、成功字段 |
| `dashboard/public/app.js` | 房间表加「结束对局」按钮 + `abortMatch()` + 确认框 |
| `matchmaker/account.cjs` | 新增 `POST /api/admin2/rooms/abort`（权限复用 `rooms.close`，审计动作 `abort-match`） |
| `matchmaker/public/admin.html` | 房间表加「结束对局」按钮 + 事件委托处理 |

> ⚠ `admin.html` 被 `.gitignore` 排除（仓库不公开管理后台），这是**既定设计**。
> 所以它只改本机，不进仓库；`repo-sync/matchmaker/public/admin.html` 那份只是本地副本。

#### 生效方式

- **`server/` 改动必须重启节点** —— 该节点上没重启就用，「结束对局」会返回 405
  （控制台会翻译成「node-N 还没重启到最新代码」）
- `dashboard` / `matchmaker` 重启即生效
- `admin.html` 刷新页面即生效

#### 端到端验证（2026-10-29 实测，node-9）

用测试账号在**空闲节点**上自建房跑一局，然后调接口（不碰玩家房间）：

```
abort 接口: 200 {"ok":true,"code":"EABB","humans":1,"roomKept":true}
房间还在: 是 ✓
已退回大厅: 是 ✓        （room.state.inMatch 由 true 变 false）
座位保留: 是 ✓
```

**注意**：`/admin/room/abort` 第一次测返回 **405**，原因是那台节点还没重启到新代码 ——
这正是 §9.13 那个坑的同类表现，不是接口本身的问题。

### 9.22 房间玩家标签两个后台各写一份，改一边忘一边（2026-10-29 重构）

**现象**：同一批玩家，「管理员」标签在节点控制台和 matchmaker 管理后台长得不一样。
维护者反馈后改了**三轮**才对上，每次都只改到一处：

1. 后台是紫色药丸（`#d9c2ff` / `rgba(160,120,255,…)`），控制台是红色。
2. 换成琥珀色 —— 但维护者要的是**照抄控制台**，不该自己配色。
3. 把内层徽章改对红色后，**外框还是红的**：因为后台多了一条
   `.room-player.is-admin{border-color:rgba(217,83,79,.42)}`，而控制台
   **从来没有这条规则**（管理员只由内层 `.room-kind.is-admin` 着红，外框保持基础灰）。
4. 最后发现尺寸也不一样（后台 11px / `3px 6px` / `gap:3px` / `line-height:1.4`，
   控制台 12px / `3px 7px` / `gap:4px` / `line-height:1.5`）。

**根因**：同一样式在两处各维护一份。这两处后台（`dashboard/`、`matchmaker/public/admin.html`）
都是本机自写的代码，不是上游产物，所以没有「按作者设计保存」的约束 —— 不一致纯属疏漏。

**修法（单一来源）**：

```
shared/admin-ui/room-tags.css     ← 唯一权威定义（数值就是控制台原值）
```

两个服务各自把该目录映射成 `/__admin-ui/*` 挂出去（因为两边各有自己的 `public/`，
互相读不到对方目录）：

- `dashboard/server.js` → `serveStatic()` 里 `pathname.startsWith('/__admin-ui/')`
- `matchmaker/server.js` → 同样处理，基准目录用 `SP_ROOT` 或 `../`

页面里都是 `<link rel="stylesheet" href="/__admin-ui/room-tags.css">`。
**本地只保留容器特有的约束**（控制台 `max-width:360px`、后台 `max-height:4.6rem` 滚动区），
玩家/观战者标签本身一行都不留。

**以后要改玩家标签样式，只改 `shared/admin-ui/room-tags.css` 一处，两个后台同时生效。**

**验证方法**（两条都必须做）：

```
# 1. 两个服务都能吐出同一个文件
curl http://127.0.0.1:3080/__admin-ui/room-tags.css   → 200, text/css
curl http://127.0.0.1:3090/__admin-ui/room-tags.css   → 200, text/css（字节数相同）

# 2. 本地不再残留重复规则（应为 0）
grep -c '#rooms-bar \.room-kind\.'  dashboard/public/index.html   → 0
grep -c '#roomBody \.room-kind\.'   matchmaker/public/admin.html  → 0
```

路径穿越防护已测：`/__admin-ui/../server.js` → 404，`/__admin-ui/` → 403。

**教训**：

- 用户说「跟 X 一样」就是**字面一致**，不要自作主张换配色（「暖色更顺眼」不是理由）。
- 抄样式时**先确认目标有没有那条规则**。控制台没有 `.room-player.is-admin`，
  后台就不该有 —— 多写一条就是多一处漂移点。
- 两处都自写的 UI，出现不一致时优先**合并成一份**，而不是反复对齐数值。

**后续事故（2026-10-29，同一天发现）**：合并成共享文件后，**管理后台的玩家标签一度完全没有样式**
（玩家名变成纯文字、没有胶囊边框）。原因是：

- Node 服务侧已经能吐 `/__admin-ui/room-tags.css`（本机 `:3090` 直连 → 200 ✓）
- 但 **nginx 里没有加转发规则**，经域名访问 `/__admin-ui/room-tags.css` 被 `location /`
  打到游戏节点上 → **404**

维护者是通过 `https://stronghold.luobomiao.love/mm/admin.html` 访问后台的，
所以 CSS 拿不到，标签退化成纯文字。节点控制台那边是本地访问，因此看起来正常 ——
这种「一边正常一边不正常」最容易误判成样式写错。

**已在 nginx 补上**：

```nginx
location ^~ /__admin-ui/ {
  proxy_pass http://127.0.0.1:3090;    # 原样转发，matchmaker 的 serveStatic 认 /__admin-ui/
  proxy_hide_header Cache-Control;
  add_header Cache-Control "no-store" always;
}
```

**验证（必须两边都测，只测本机会漏掉这类问题）**：

```
直连: :3090/__admin-ui/room-tags.css                      → 200, 3302 B
域名: https://stronghold.luobomiao.love/__admin-ui/room-tags.css → 200, 3302 B
```

**教训**：新增一个静态资源路径时，**Node 服务能返回 ≠ 浏览器能拿到**。
只要页面实际是通过 nginx 域名访问的，就必须同时在 `nginx.conf` 里加对应的
`location` 转发。以前 `/mm/*`、`/css/`、`/js/` 都是这么处理的，这次漏了。

**排查这类「样式突然没了」的最快顺序**：

1. 浏览器 F12 → Network，看那个 CSS 是不是 404（本例就是）
2. 直连 Node 端口试同一个路径（200 说明服务端没问题，问题在 nginx）
3. 搜 `nginx.conf` 有没有对应的 `location`

### 9.28 部署静态文件：先写 `node-1`，`shared` 里的走 junction（2026-10-30）

**分发脚本的源是 `node-1`，不是 `repo-sync`。** `deploy/sync-nodes.cjs` 第 33 行：

```js
for (const d of DIRS) ref[d] = walk(path.join(ROOT, 'node-1', d));
```

所以「改仓库 → 跑 `--apply`」**什么都不发生**（会输出「完成：共复制 0 个文件」），
因为 `node-1` 自己还是旧版，30 个节点跟它一致。正确顺序是：

```
repo-sync/<file>  →  node-1/<file>  →  node-2…30
                       ↑ 先手动覆盖这一份
```

**这一条以前没写清楚，2026-10-30 踩到过一次。**

#### 哪些目录是 junction（写了就等于写 30 个节点）

| 路径 | 类型 | 指向 |
|---|---|---|
| `node-N/public/i18n` | **Junction** | `shared/public/i18n` |
| `shared/` 其余部分 | Junction | 由部署脚本建立 |
| `node-N/public/js/` | **真实目录**（逐节点副本） | — |
| `node-N/server/` | **真实目录**（逐节点副本） | — |

推论：

- **改 i18n 文案**：写一次 `shared/public/i18n/`（或经 `node-1/public/i18n/`，
  它指向同一个地方），30 个节点**立刻全部生效**，`sync-nodes` 会报「0 处差异」——
  **这是正常的，不是没同步**。
- **改 `public/js/`、`server/`**：必须走上面的「先 node-1 再分发」两步。

#### 生效条件

| 改动 | 生效方式 |
|---|---|
| `public/js/**`、`public/i18n/**`、`public/css/**` | **玩家刷新即可**，不需要重启节点 |
| `server/**` | 必须重启节点（按重启纪律，只动 `matches=0` 的） |

`/js/**` 线上返回 `Cache-Control: no-cache`，所以刷新一定能拿到新版，不会卡在旧缓存。

#### 验证命令

```powershell
# 1. 一致性（必须 0 处差异）
$env:SP_ROOT='D:\Stronghold-Protocol'; node repo-sync\deploy\sync-nodes.cjs

# 2. 线上真的返回新内容（挑几个节点直连 port，再走一次 nginx）
(Invoke-WebRequest "http://127.0.0.1:3001/js/screens/<file>.js" -UseBasicParsing).Content.Contains('<新代码里的唯一字符串>')
```

### 9.27 `SP_REDIS_URL` 断点持久化 —— **0.3.1 遗留代码，官方已移除（重要）**

> ⚠ **2026-10-30 二次核实推翻了本节原结论。** 原来写的是「sganggs 上游原生功能」——
> **这是错的**。官方 0.3.3 完整包（`安装包/Stronghold-Protocol-master-sganggs.zip`）里
> **完全没有**这套代码。详见下面「官方溯源」。
>
> **它现在能用，但属于「上游已删除、本服还在用」的遗留能力。升级时必须主动保留，
> 否则房间恢复与断线重连会突然失效。**

#### 官方溯源（2026-10-30，用官方完整包逐文件核对）

| 来源 | 版本 | `server/persist/` | `server/cluster/` |
|---|---|---|---|
| 官方完整包 `Stronghold-Protocol-master-sganggs.zip` | **0.3.3** | ❌ **没有** | ❌ **没有** |
| `_ref-ann1/Stronghold-Protocol-master` | 0.3.1 | ✅ 有 | ✅ 有 |
| `_ref/Stronghold-Protocol-master` | 0.3.0 | ✅ 有 | ✅ 有 |
| 本服 `node-1` | 0.3.3 | ✅ **有**（0.3.1 遗留） | ❌ 没有 |

在官方 0.3.3 包里精确搜索的结果：

```
"server/persist"   → 0 处
"SP_REDIS"         → 0 处
"valkey.js"        → 0 处
```

（搜 `checkpoint` 有 92 个匹配，但那是游戏语义里的「关卡检查点」，与持久化无关。）

**结论**：作者在 0.3.2 之后把 `cluster/` 与 `persist/` 整套删掉了，连 `DEPLOY.md`
里的「断点续玩」章节也一并移除。本服的 `server/persist/` 是 0.3.1 留下的残存代码。

#### 为什么本服还能用

本服的更新是 `update.js` 应用更新包（只增改、不清理已删文件），0.3.1 带的
`server/persist/` 就一直留在磁盘上，`server/index.js` 里对它的调用也还在，
所以 `SP_REDIS_URL` 至今有效。

#### 用到的能力（**必须保住**）

| 能力 | 状态 |
|---|---|
| **房间恢复**（重启后房号/房主/成员还在） | ✅ 需要 |
| **断线重连**（座位、阵容、回合、经济原样回来） | ✅ 需要 |
| 节点重启保住对局 | ❌ 做不到（见下） |

#### 升级上游时的保护清单

**升级前必须确认以下几点，否则持久化会失效：**

**① 保留整个目录**

```
node-1/server/persist/          ← 6 个文件，一个都不能少
  index.js        2.7KB
  lobbyState.js   16.6KB   ← 本服改过（+1.1KB：version 隔离 + 扩展人数字段）
  node.js         7.8KB
  persister.js    20.3KB
  store.js        9.2KB
  valkey.js       13.4KB
```

**② 保留三处调用代码**

| 文件 | 位置 | 内容 |
|---|---|---|
| `server/index.js` | L47 | `import { createPersistence } from './persist/index.js';` |
| `server/index.js` | L171 | `persistence = await createPersistence({ registry, lobby, log });` |
| `server/lobby.js` | L1328 | `try { this.persistFlush?.('room-create'); } catch { /* ignore */ }` |

外加 `server/match/snapshot.js:98` 的 `'onCheckpoint'` 字段登记（Match 字段分类表）。

**③ 升级后验证**

```bash
# 启动日志里应该有这一行
[persist] checkpoints on (every 10 s)

# Redis 里应该有钥匙
# sp:nN:lobby / sp:nN:lobby:rooms / sp:nN:lobby:sessions
```

**④ 如果上游某天真把功能加回来**

关注官方是否重新出现 `server/persist/` 目录或 `SP_REDIS_URL` 变量。
一旦出现，本服直接跟进即可（配置已经就位，不需要额外改造）。

#### 本服唯一的改动：`lobbyState.js` +1.1KB

来自：
- `998fc0d2` 房间持久化补存 `version` 以恢复版本隔离
- 5–20 人房扩展（房间存档字段）

**其余 5 个文件与 `_ref-ann1`（0.3.1）逐字节一致。**

#### 配置项

| 变量 | 含义 | 本服当前值 |
|---|---|---|
| `SP_REDIS_URL` | `redis://[user:pass@]host[:port][/db]`，不设 = 关闭 | `redis://127.0.0.1:6379/0` |
| `SP_REDIS_PREFIX` | 键前缀，多套服务器共用一个 Redis 时各用各的 | 每节点独立，如 `sp:n1:`、`sp:n5:` |
| `SP_PERSIST_SAVE_MS` | 定时存档间隔，默认 10000 | 未设（默认 10 秒） |
| `SP_REDIS_PASSWORD_FILE` | 从文件读密码，不必写进环境变量 | 未用 |

#### 节点重启保住对局：做不到

`server/persist/persister.js` 的单机分支（`if (!this.cluster)`）直接 `abortRestoredMatch(room)` ——
只保留房间、中断对局。`restoreLocal()` 虽然写了，但它调用的

```js
this.lobby.startMatch(room, room.matchKey, room.matchKeys, { restore: {...} });
```

在 `lobby.js` 里是 `startMatch(room, key = null)` —— **第 3、4 个参数被静默丢弃**，
`restoreMatch()` 从未被调用。实测日志报 `restored 1 match(es)` 但实际是新开了一局
（种子/地图/回合/matchNo 全变）。详见 §9.26。

#### 快速检查命令

```powershell
# Redis 是否在跑
Get-NetTCPConnection -State Listen -LocalPort 6379

# 有没有在写检查点
#   node 直连：SCAN 0 COUNT 500，看 sp:n*:cp:* 的 savedAt
```

### 9.26b 维护者说「设计稿」时，不要碰生产（2026-10-30，重复犯错）

**事故**：维护者在讨论 `docs-plan/login-design/` 里的登录界面设计稿，几次要求微调
（改示例邮箱、改提示文案、调手机上的疏密）。我**两次**把改动直接落到生产环境：

1. 改了 `matchmaker/public/account-title.js` 的占位符 + 升 nginx `sub_filter` 的 `?v=`
   + 重启 nginx；
2. 第二次同样改了 `account-title.js` 并升版本号，**改完还没及时回滚**，被追问才撤回。

维护者原话：「你给我看的新界面。没让你改现在线上的版本」「我是说设计稿的。
不要跟我扯到线上版本」。

#### 根因

设计稿里出现过的字符串（`123456@qq.com`、`QQ 邮箱（如 …）`）**和线上代码里的完全一样**
—— 因为设计稿本来就是仿照线上界面画的。于是「改设计稿里的这句」和「改线上那句」
指的东西看起来是同一个，我按线上的位置去找，就改到生产上了。

#### 规则

| 维护者说的是 | 只许动 | 绝对不动 |
|---|---|---|
| **「设计稿」/「预案」/指向 `docs-plan/`** | `docs-plan/` 下的文件 | `matchmaker/`、`nginx/`、`node-*/`、`dashboard/`、`shared/` |
| 「线上」「现在玩家看到的」 | 生产环境 | 先走重启纪律，并说明会碰哪些进程 |

**判断方法**：先看维护者这句话的上下文里有没有 `docs-plan/` 的路径、或者引用的是
「设计稿」这个词本身。有 → 只改文档目录。

**要碰生产时，先一句话问清楚**，不要顺手改。改错了要**立刻**回滚并说明，
不要等到被追问。

#### 同类错误（同一模式：一句话做了三件事）

| 维护者说 | 我做的 | 该做的 |
|---|---|---|
| 改 `(如 123456@qq.com)` | 改线上代码 + 升 nginx 版本 + 重启 nginx | 只改设计稿那一处 |
| 「不是让你这么写」 | 把整行说明都删了 | 只改括号里的数字 |
| 设计稿的登录界面 | 改 `account-title.js` | 改 `docs-plan/login-design/` |

**一句话原则：按最小改动做；不确定就先用一句话问，不要顺手「优化」别的。**

#### 顺带发现（与本节相关）

`matchmaker/public/account-title.js` 里有一段 **9 行生产环境本地改动从未提交进 git**
（2026-10-28 的「只在标题页拦截开始按钮」修复，`if (!titleScreen()) return;`）。
`repo-sync` 里的那份有这 9 行，`git show HEAD:` 里没有 —— 即生产上有一个游离于版本库
之外的补丁。**重新部署 `repo-sync` 版本会把它覆盖掉。** 尚未提交，需要维护者决定。

### 9.26 「节点重启保住对局」做不到 —— 实验记录与结论（2026-10-30）

**背景**：`SP_REDIS_URL` 检查点已启用，能保住**房间**、**会话**、**断线重连**。
维护者问：能不能连**进行中的对局**也保住（重启节点后接着打）？

**结论：在当前架构下做不到。已实验验证并回滚。**

#### 上游的设计

`server/persist/persister.js` 的 `restore()` 里：

```js
if (!this.cluster) {
  // A process restart must not silently resume a match: keep the alliance room, but
  // return it to its waiting state so clients show 返回同盟 instead of continuing.
  this.abortRestoredMatch(room);      // 单机：强制中断对局
  this.counts.droppedMatches++;
  continue;                            // 根本不尝试恢复
}
```

**单机模式（本服的架构）重启必中断对局**，这是上游明确的设计，注释理由也写清了：
重启后玩家 socket 全断，静默恢复一局「正在进行」的对局会让人不知道发生了什么。

#### 为什么集群模式也走不通

`this.cluster = typeof lobby.remoteMatchRef === 'function'`（persister.js:59）

**2026-10-30 二次核实（修正了第一版结论）**：

| 来源 | `server/cluster/` | `lobby.remoteMatchRef` |
|---|---|---|
| 本服 | ❌ | ❌ |
| **sganggs 上游 0.3.2** | ❌ | ❌ |
| **sganggs 上游 0.3.3** | ❌ | ❌ |
| sganggs 上游 0.3.3-clean | ❌ | ❌ |
| **`_ref/Stronghold-Protocol-master`（0.3.0 fork）** | ✅ **有 18 个文件** | ❌ |

**准确的说法**：sganggs 上游（0.3.2、0.3.3）**从来没有 cluster 架构**，
`server/cluster/` 只存在于 `_ref/Stronghold-Protocol-master` 这个 **0.3.0 时期的 fork**里。
（第一版写的「上游 0.3.3 已移除 cluster」不准确 —— 不是移除，是上游本来就没有。）

佐证：sganggs 0.3.3 的 `DEPLOY.md` 全文搜索「集群 / cluster / 协调器 / coordinator」
**零命中**；而 0.3.0 fork 的 `DEPLOY.md` 有完整的集群章节。

而 `remoteMatchRef` 这个决定 `cluster` 的函数，**在所有来源里都不存在** ——
包括有 cluster 目录的 0.3.0 fork。所以 `this.cluster` 永远为 `false`，
集群分支（`restoreRemoteMatch`）在任何一个版本里都是**死代码**。

#### ⚠ 文档缺口：`DEPLOY.md「断点续玩」章节在上游 0.3.3 里不存在

`sganggs 0.3.3` 的 `server/persist/index.js` 开头写着：

```
// server/persist/index.js — the server's side of the checkpoints (docs/DEPLOY.md「断点续玩」):
// off unless SP_REDIS_URL names a Valkey / Redis compatible store
```

**但上游 0.3.3 的 `DEPLOY.md` 里没有「断点续玩」这一章。** 搜遍上游全部文档
（DEPLOY / PLAYING / PLUGIN-API / PLUGIN-DSL / PLUGIN-GUIDE / PLUGINS / SKINS），
`SP_REDIS_URL`、`SP_REDIS_PREFIX`、`Valkey`、`断点续玩` **全部零命中**。

同样的注释也提到 `server/cluster/game-runtime.js` —— 那个文件在上游也不存在。

**结论**：`persist` 的代码是上游 0.3.3 原生的（6 个文件齐全，`SP_REDIS_URL` / `SP_REDIS_PREFIX`
在 `store.js:54-57` 真实读取），但**配套文档没有跟随**。代码注释指向了两个上游没有的东西
（文档章节、cluster 目录），说明这块代码在上下游之间文档脱节。

**对本服的影响**：`SP_REDIS_URL` 功能本身完全可用（房间/会话/断线重连，实测正常），
只是上游没有文档说明。配置项见 §9.27。

#### 试过什么（失败记录）

把单机分支改成先尝试 `restoreLocal()`：

```js
let restored = false;
if (ref && ref.kind === 'local' && typeof ref.id === 'string') {
  try { restored = await this.restoreLocal(room, ref, departed); } catch { restored = false; }
}
if (!restored) { this.abortRestoredMatch(room); this.counts.droppedMatches++; }
else matches++;
```

**结果：日志报 `restored 1 match(es)`，但实际是新开了一局。**

**根因**：`restoreLocal()` 调用的是

```js
this.lobby.startMatch(room, room.matchKey, room.matchKeys, { restore: {...} });
```

而 `lobby.js` 里是

```js
startMatch(room, key = null) {    // ← 只接受 2 个参数
```

**第 3、4 个参数被 JavaScript 静默丢弃**，`restoreMatch()` 从未被调用。
`restoreLocal()` 返回 `true` 只是因为 `startMatch()` 没报错（它开了一局新的）。

实测数据（房间 ULRY，node-5）：

| | 种子 | 地图 | 回合 | matchNo |
|---|---|---|---|---|
| 重启前 | `1727835050` | `act2autochess_m04` | **3** | 2 |
| 重启后 | `1581560527` | `act1autochess_m04` | **1** | **3** |

种子、地图、回合、matchNo **全部变了** —— 铁证是新开局，不是恢复。

**这个改动比上游原版更危险**：上游是「中断对局 + 提示返回同盟」（诚实），
改后变成「静默开新局」（玩家以为进度还在，实际全丢）。**已回滚。**

#### 复盘教训

1. **`restored 1 match(es)` 这个日志不可信** —— 它只代表 `restoreLocal()` 返回了 true。
   验证恢复是否成功，必须核对 **`matchNo` 是否不变、`round` 是否接上、`seed` 是否一致**。
   这些数据当时就在手上，我没有横向对比就宣布成功。
2. **`restoreLocal()` 是上游的未完成代码** —— 留下了函数但 `startMatch` 不支持它的
   `{ restore }` 选项。上游自己都没接通，不是「我们没配好」。
3. **改配置 vs 改架构** —— 维护者问「换成集群模式行不行」时，
   看起来像配置调整，实际需要重新引入整个 `server/cluster/` 并重构部署。

#### 要做到的话需要什么

改 `lobby.js`（181KB 核心文件）的 `startMatch()` 支持 `{ restore }` 选项，
涉及对局初始化完整流程：创建 Match 实例、注入存档、绑定座位、处理已离开玩家、
重建 RNG 状态、恢复计时器。**工程量和风险都是另一个量级，且偏离上游。**

#### 如果上游后续更新了这块

关注这几个文件的变化：
- `server/persist/persister.js` 的 `restore()`
- `server/persist/node.js`
- `lobby.js` 的 `startMatch()` 是否新增 `restore` 参数
- 是否重新出现 `server/cluster/` 目录或 `lobby.remoteMatchRef`

一旦上游让单机也支持恢复，本服可以直接跟进（`SP_REDIS_URL` 已经配好，无需额外改造）。

#### 当前状态（已回滚）

- `persister.js` 在 30 个节点上**全部与上游 0.3.3 逐字节一致**
- 备份保留在 `backups/persist-local-restore-20261030-011619/`
- node-5 的 3 个测试检查点已从 Redis 清理
- 房间 / 会话 / 断线重连的持久化**不受影响，正常运行**

### 9.25 救援提示「本轮合格联防队友的生命值都不足 11」与实际不符（2026-10-29）

**现象**：维护者截图显示提示「本轮合格联防队友的生命值都不足 11，无法支付救援」，
但界面上明明有队友的血量够 11。

**代码位置**：`server/match/Match.js` 的 `_revivalDeathReason()`。

**旧逻辑**：

```js
const helpers = this.order.filter((p) => ... && p.alive && this._revival.eligible.has(p.playerId));
if (!helpers.length) return 'no-helper';
return helpers.every((p) => Number.isFinite(p.lp) && p.lp < REVIVAL_MIN_DONOR_LP) ? 'donor-lp' : 'window-closed';
```

**根因**：`helpers` 里**包含正要结算的这个死者自己**。

`_finalizeDeath(ps)` 通过默认参数 `reason = this._revivalDeathReason(ps)` 调用它，此刻：

- `ps.alive` 仍是 `true`（`_deferDeath` 还没把它标成死亡）
- `ps.lp` **已经被扣到 ≤ 0**（`settle.js:48` 先扣血，`settle.js:84` 才判 canRescue）

于是那个「结算前够 11、扣完本轮损失后不够 11」的队友**就是死者自己**，
`every(lp < 11)` 因为他自己成立 → 返回 `donor-lp` → 提示「都不足 11」。

玩家在界面上看到的是**别人的**血量（还够），自然觉得提示是错的。

**修法**：判断「有没有人付得起」时**排除死者本人**，并且直接按 `lp >= 11` 筛：

```js
const helpers = this.order.filter((p) => p !== ps && ... && p.alive && helperIds.has(p.playerId));
if (!helpers.length) return 'no-helper';
const canPay = helpers.some((p) => Number.isFinite(p.lp) && p.lp >= REVIVAL_MIN_DONOR_LP);
return canPay ? 'window-closed' : 'donor-lp';
```

**注意口径一致性**：`views.js:117` 发给客户端的 `eligible` 用的是
`revivalDonorEligible()`（含 `lp >= 11`），而旧的 `_revivalDeathReason` 用的是
**不含 lp 过滤**的集合 —— 两处口径不一样，是这类「提示和界面打架」的常见成因。
以后改这块务必让两边用同一组条件。

**验证**：

```
test/content/feedback5-revive-redeploy.test.js      pass 4 / fail 0
test/content/feedback5-swire2-revive-cost.test.js   pass 2 / fail 0
```

**顺带确认的既有失败（与本次无关）**：`test/match/` 下 4 个文件共 38 个用例失败
（abyss-advisor 1、advisor-economy 12、advisor-execution 24、ai-playbook 1）。
用 `git show HEAD:server/match/Match.js` 跑同样 38 个，数量完全一致。

### 9.24 同一玩家在房间里出现两次 + 资源加载慢（2026-10-29）

#### A) 玩家占两个座位（房间 DVWE，玩家「山雎」）

**现象**：房主踢人时日志出现两条 `DVWE 山雎 removed by the host`，相隔 4 秒 ——
说明座位表里有**两份**同一个玩家，踢一次只清掉一个。

**根因**（两个漏洞叠加）：

1. `accountRoomConflict()` 遍历房间时**找到第一个匹配座位就 return**，房间里的第二个
   同账号座位它永远看不到；`removeMember()` 用 `room.seatOf(playerId)` 也只删第一个。
2. 更关键：`humanSeat()` 只在**落座那一刻**写一次 `accountId`，而玩家落座时 hello
   还没带账号令牌（令牌是异步补发的）。这种座位的 `accountId` 是 `null`：
   - `accountRoomConflict` 的账号比对认不出它（兜底反查会话在断线后也拿不到 accountId）
   - `dropStaleAccountSeats` 要求 `seat.accountId === accountId` 才清，同样跳过它

   于是旧座位成了**永久孤儿**。玩家再进来拿到新 `playerId`（`net.js:185` 每个 WS
   连接都生成新的），又占一个座位 → 一个人两个座位。

**修法**：新增 `Room` 外的 `Lobby.dedupeSeats(room, session)`，并在三处调用：

| 调用点 | 时机 |
|---|---|
| `join()` 接管分支（座位换成当前会话之后） | 同房间重连/换设备 |
| `join()` 新占座位之后 | 新标签页/新设备另占一个座位 |

**安全边界（都有单元测试覆盖，`node-1/test/match/dedupe-seats.test.mjs`）**：

- **只有已登录账号（`accountId` 非空）才去重** —— 游客和测试里没带账号的会话一律不动。
  这条是必须的：第一版没加，把测试里的队友当成「同账号」清掉了
  （`lobby-integration.test.js` 从 5 红变成……其实它本来就是红的，见下）。
- **当前会话自己的座位永远保留**（`seat.playerId === session.playerId` 直接跳过）。
- **对局进行中直接 return 0**，绝不动座位（与 `dropStaleAccountSeats` 的保护一致）。
- 座位 `accountId` 为空时反查会话，但**要求查到的会话 accountId 一致**，不靠空值兜底。
- 清完如果房主座位没了会 `migrateHost`；房间空了照常解散。

**注意**：`lobby-integration.test.js` 的 5 个用例在本项目里**本来就全红**，原因是
本服自加的规则「游客不能创建房间」（`lobby.js:1237`），而用例还在用游客身份建房。
用 `git show HEAD:server/lobby.js` 跑同样 5 红，与本次改动无关。
排查时别被它误导（`_ref/pristine/` 是 1884 行的早期版本，**不能**当对照）。

#### B) 资源加载慢

**两个独立原因。**

**B1. `assets.json` 每次打开页面都要重下（3.9 MB）**

`/data/assets.json` 在 nginx 里是独立 location，**没写 Cache-Control**，
于是沿用了节点服务返回的 `no-cache`。实测：

| 情况 | 传输量 | 耗时 |
|---|---|---|
| 不压缩 | 4,060,993 B | 264 ms |
| gzip | 400,679 B | 38 ms |

修法：换成 `public, max-age=86400`（1 天）+ 保留 ETag（`proxy_hide_header Cache-Control`）。
**没有用 30 天 immutable**：这几个文件是固定 URL（无 `?v=`、无内容哈希文件名），
30 天 immutable 会让浏览器完全不发请求、ETag 没机会生效，换资源包后玩家卡在旧清单上。
1 天后再来只回 304（几百字节）。

**B2. 素材 404 被缓存 30 天（这个更致命）**

源站 `assets.luobomiao.love` 对 **404 也返回** `Cache-Control: public, max-age=2592000, immutable`。
`@assets_origin` 里虽然有 `proxy_ignore_headers Cache-Control`，但那**只影响 nginx 自己的
缓存判断，不会阻止上游响应头转发给浏览器**。于是响应里出现两个 Cache-Control：

```
Cache-Control: public, max-age=2592000, immutable   ← 源站的 404
Cache-Control: no-store                             ← 我们自己的 add_header
```

浏览器通常采纳第一个 → **一次 404 被缓存 30 天，刷新也拿不到**。
玩家看到的正是「某个素材永远加载不出来 / 加载慢」。

`/assets-cdn/` 早就补了 `proxy_hide_header Cache-Control` + `proxy_hide_header Expires`，
**`@assets_origin` 一直漏着**。已补上。

验证（修复后）：

```
/assets/char/__nonexistent__.png  →  Cache-Control: no-store        （只有一个头）✓
/data/assets.json                 →  Cache-Control: public, max-age=86400  ✓
/                                 →  200
```

**排查时记住**：看到两个同名响应头，就是「上游带头 + `add_header` 再带一个」，
必须用 `proxy_hide_header` 把上游那个丢掉，`proxy_ignore_headers` 不够。

### 9.23 自动重启脚本长期空转，节点一直跑旧代码（2026-10-29 修复）

**现象**：`node-8`、`node-10`、`node-30` 的 PM2 uptime 挂了 **23 小时**，`/admin/room/abort`
一直返回 405（旧代码）。但 `sync-nodes --apply` 显示「0 处差异」—— 文件早就到位了，
只是进程没重启。

**三层原因，一层比一层深**：

1. **mtime 误判**：脚本用「`node-1/server` 下最新 mtime」当 `codeAt`，而每次
   `sync-nodes --apply` 都会刷新 mtime（即使内容一模一样）。于是 `codeAt` 不断前移，
   进程启动时间不动，节点永远被判「旧代码」。
   → 改为内容指纹 `content/rolling-code-stamp.json`，内容没变就沿用上次部署时刻。

2. **脚本语法整体崩掉（真正的元凶）**：`deploy/rolling-restart.ps1` 是 **UTF-8 无 BOM**，
   计划任务用 `powershell.exe`（5.1）跑，**5.1 对无 BOM 的 .ps1 按 GBK 解析**。文件里的
   中文注释/字符串导致引号和括号配对错乱，5.1 报：

   ```
   Unexpected token 'UTF8Encoding.GetBytes' in expression or statement.
   The string is missing the terminator: '.
   The Try statement is missing its Catch or Finally block.
   ```

   而脚本开头有 `$ErrorActionPreference = 'SilentlyContinue'`，**把解析/运行错误全吞掉**，
   表现成「找不到进程 → 静默 exit 0」。日志里长期只是：
   ```
   no node processes visible -> skip
   ```
   → **已给 .ps1 加 UTF-8 BOM**，`throw` 消息全部改 ASCII。

3. **`Get-FileHash` 不可用**：这个 cmdlet 来自 `Microsoft.PowerShell.Utility` 模块，
   在计划任务的精简环境里可能整个模块都没加载，报 `not recognized`。
   → 改用 `[System.Security.Cryptography.SHA256]::Create()` 直接算字节哈希。

**顺带踩到的 5.1 坑**（都写进脚本注释了）：

| 写法 | 结果 |
|---|---|
| `$a.B |` 换行接 `Measure-Object` | 跨行管道可能算出 null |
| `New-Object System.Text.UTF8Encoding $false` | 位置参数 `$false` 被吞，静默返回 **null** |
| `[System.Text.Encoding]::UTF8.GetBytes()` | 某些宿主下静态属性为 null |
| 无 BOM 的 .ps1 含中文 | 5.1 按 GBK 解析 → 语法崩 |

**排查方法（关键）**：不要只看日志。脚本里的 `SilentlyContinue` 会吞掉一切，
必须直接看 5.1 的 stderr：

```powershell
cmd /c 'powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "D:\Stronghold-Protocol\deploy\rolling-restart.ps1" 2>&1'
```

**验证（修复后实测）**：

```
第一次运行：1.9 秒，server/ content changed -> new stamp a26428824d44
第二次运行：16.4 秒，idle + old code: 7,9,10,12,14,15 -> startOrReload
                    restarted 6/6 (7,9,10,12,14,15)
```

第二次运行正确复用戳（未重写），并真实重启了 6 个空闲节点。
**逐个核对过日志：这 6 个节点重启前的最后一条对局记录都是 `match ended` + `disposed (empty)`，
没有打断任何玩家。**

**重启纪律不变**：脚本只动 `matches=0 且 sockets=0 且 rooms=0` 的节点。

**教训**：

- 定时任务里的 PowerShell 脚本**必须带 BOM**，否则中文会毁掉整个文件。
- `$ErrorActionPreference = 'SilentlyContinue'` 在运维脚本里是双刃剑：
  它能避免噪音，但也会让「脚本根本没跑起来」伪装成「没有可做的事」。
- 判断「代码是否更新」用**内容指纹**，永远不要用 mtime。

### 9.18 HTTPS 证书续期一直失败（2026-10-29 修复）

**症状**：计划任务 `SP-LetsEncrypt-Renew`（每天 03:30）**天天失败**，结果码
`4294967295`（= `-1`）。证书本身暂时没事（当时还剩 80 天），但再没人管就会到期。

#### 两个路径都是旧的

| 位置 | 原来写的 | 实际 |
|---|---|---|
| `tools/acme/renew.bat` | `D:\Program Files\nodejs\node.exe` | **`D:\nodejs\node.exe`** |
| `tools/acme/renew.cjs` | `D:/sp-nginx/nginx.exe` + `-p D:/sp-nginx/` | `D:/Stronghold-Protocol/nginx/` |

第一个让整个脚本**根本没启动**：`renew.log` 里只有一行「系统找不到指定的路径。」
第二个更隐蔽：即使续期成功，`nginx -s reload` 也**永远静默失败**（旧路径不存在），
新证书写到磁盘、nginx 还在用旧的 —— 表现是「证书明明续了，浏览器还报过期」。

> 这和控制台那个「nginx 按钮指向 `D:\sp-nginx`」是同一个历史遗留：
> 服务器从 `D:\sp-nginx` 迁到 `D:\Stronghold-Protocol\nginx` 时，有些地方没跟着改。
> **凡是看到 `sp-nginx` 的地方，基本都是迁移漏网之鱼。**

#### 修复

**`renew.bat`**：不再写死路径，先找 PATH 里的 node，再退回已知位置：

```bat
set "NODE_EXE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
```

**`renew.cjs`**：`NGINX_PREFIX = 'D:/Stronghold-Protocol/nginx/'`；
reload 失败时打印 `WARN ...` 而不是无声吞掉。

**⚠ `.bat` 文件必须保持纯 ASCII。** cmd.exe 按 OEM 代码页解析 `.bat`，
UTF-8 的中文注释或中文引号会被当成命令执行（无害但满屏报错）。
第一次改的时候我写了中文 REM，立刻炸出一堆「不是内部或外部命令」，
所以最终版的注释全是英文。

#### 验证方式

**1. 手动跑一次**（证书还有 80 天时会直接跳过，不当真续）：

```powershell
cmd /c "D:\Stronghold-Protocol\tools\acme\renew.bat"
Get-Content D:\Stronghold-Protocol\tools\acme\renew.log
# 正常输出：
#   using "D:\nodejs\node.exe"
#   certificate days left: 80
#   no renewal needed
```

**2. 触发计划任务，看返回码**：

```powershell
schtasks /Run /TN "SP-LetsEncrypt-Renew"
Start-Sleep 20
(Get-ScheduledTaskInfo -TaskName 'SP-LetsEncrypt-Renew').LastTaskResult   # 必须是 0
```

**3. 验证 ACME 挑战路径可从公网读到**（续期成败的关键，**必须走 HTTP/80**）：

```powershell
# 建一个临时文件，然后用 http:// 访问（不是 https）
#   http://stronghold.luobomiao.love/.well-known/acme-challenge/<文件名>
# 能读回同样内容 = Let's Encrypt 也能读到
```

nginx 的配置是 `listen 80` 的 server 里：

```nginx
location /.well-known/acme-challenge/ { root D:/Stronghold-Protocol/acme; try_files $uri =404; }
```

**别用 https 测**——443 的 server 块里没有这条 location，会 404，但那不代表续期会失败
（http-01 挑战只走 80 端口）。我第一次就是这么误判的。

#### 当前状态（2026-10-29 12:43）

- 证书：`CN=stronghold.luobomiao.love`，到期 **2027-01-18**，剩 80 天
- 计划任务：手动触发返回 **0（成功）**
- 续期脚本：实跑输出正常
- ACME 挑战路径：实测可达
- `acme-client` 依赖：5.4.0 正常

**注意：nginx 以 SYSTEM 运行，`-s reload` 可能被拒（Access denied）。**
真到续期那天，如果 reload 失败，新证书已经在磁盘上，**下次 nginx 重启就会用上**；
脚本会打印 `WARN nginx reload failed (...)`，看到它就在方便时重启一次 nginx。

### 9.17 nginx 进程越积越多（1 master + 十几个 worker）（2026-10-29 修复）

**症状**：`Get-Process nginx` 越跑越多，实测累积到 **11 个**。正常应当是
`worker_processes 2` → **1 master + 2 worker = 3 个**。

**原因**：`reload` 之后旧 worker 会「优雅退出」—— 不再接新连接，但**要等已建立的连接
自己结束**才真正退出。本服大量是 WebSocket 长连接（对局、大厅、管理台），一个能挂几十分钟。
实测每个旧 worker 上还挂着 2 / 6 / 12 / 32 / 60 个连接，所以它们一直不退出。

**永久修复**（`nginx/conf/nginx.conf`，`events` 同级、`http` 之前）：

```nginx
worker_shutdown_timeout 5m;
```

**作用范围 —— 只碰旧 worker，不碰当前进程**（维护者 2026-10-29 特意确认过）：

nginx 源码 `ngx_process_cycle.c` 里，reload 时只对**旧 worker** 做两件事：
`ngx_close_listening_sockets()`（关监听，不再接新连接）+ `ngx_set_shutdown_timer()`
（起计时器，到点强制关掉剩余连接并退出）。**新 worker 根本不走这段代码。**

| 进程 | 受影响？ |
|---|---|
| 当前正在工作的 worker | ❌ 完全不受影响，一个字节都不会断 |
| 已退场、挂着长连接的旧 worker | ✅ 到点强制关闭它的连接 |

所以玩家刷新页面、打对局，只要连接在当前 worker 上就无感。

为什么取 **5m**（维护者决定）：先把时间给足让连接自己结束 —— 一局通常几分钟内
会有结果或进结算，关页面时浏览器会主动断开，5 分钟能覆盖绝大多数自然退出，
把「被强制切断」的概率压得很低。代价只是旧 worker 多驻留一会儿（内存）。

#### 怎么确认生效

```powershell
# 正常应当是 3 个（1 master + 2 worker）
(Get-Process nginx).Count

# 看每个 worker 挂着多少连接（旧 worker 应该很快归零并消失）
Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" | ForEach-Object {
  $c = @(Get-NetTCPConnection -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue |
         Where-Object State -eq 'Established').Count
  "PID $($_.ProcessId)  已建立=$c"
}
```

重启 nginx 之后进程会立刻清到 3 个；之后每次 reload 也会在 30 秒内自然收敛。

### 9.16 隐身观战未开放节点上的房间 →「版本数据未能通过校验」（2026-10-29 修复 nginx）

维护者反馈：隐身观战 **CDYX（node-1）** 看了很久，切到 **AHHP（node-29，`act1autochess` 第 15 轮）**
时提示 **「版本数据未能通过校验，请刷新页面重试」**，页面卡在 `LOADING DATA`。

#### 不是版本的问题，先排除

我一开始怀疑「第一期下半」有问题，实测四个版本在故障节点上：

| 版本 | node-1 | node-20 |
|---|---|---|
| `act2autochess`（第二期下半，默认） | 200 | 404 |
| `act2autochess@V2_1` | 200 | 404 |
| `act1autochess`（第一期下半） | 200 | 404 |
| `act1autochess@V1_1` | 200 | 404 |

**连默认版本都 404**，和版本无关。

#### 真正的原因：资源请求被改派到了另一组节点

「内容指纹 `cs`」是**每台节点各自算出来的**（由 `server/sim` + `shared` + `data` 哈希而成）。
跑不同代码的节点会算出**不同的 `cs`**。2026-10-29 当时的分组：

| 组 | 节点 | `act2autochess` 的 cs |
|---|---|---|
| A 组 | **node-1、node-29** | `1cb523147acf2bef…` |
| B 组 | 其余 28 台 | `8bc7a0a3bc49d88c…` |

**每组都自洽**（用自己的 cs 请求自己 → 四个版本全部 200）。故障只发生在**跨组**。

故障链：

1. 页面通过 `?adminWatch=1&adminNode=N` 打开，**页面本身**落在 N（即使是未开放节点）
2. 页面随后自己发请求：`/cs/<cs16>/index.json`、`/data/versions/<slug>/*.json` —— 这些**不带参数**
3. 它们走 `location /` 的第 0 条规则：
   ```nginx
   if ($sp_cookie_open = 0) { set $sp_node $sp_rand_node; }
   ```
   node-1 / node-29 **不在开放列表** → `$sp_cookie_open = 0` → **被改派到随机开放节点（B 组）**
4. 页面拿着 A 组的 `cs` 去问 B 组要清单 → **404** → 「版本数据未能通过校验」

**为什么 CDYX 能看很久**：它是默认版本 `act2autochess`，数据由页面直接加载，不走 `/cs/` 清单；
**AHHP 是非默认版本**，切换必须走清单 + 16 个数据文件，正好踩中。

#### 修复：版本数据无条件跟随页面所在节点

`location /` 里新增（`nginx/conf/nginx.conf`，`$sp_is_version_data` 由新 map 定义）：

```nginx
map $uri $sp_is_version_data {
  default 0;
  ~^/cs/                 1;   # 内容集清单与 bounds
  ~^/data/versions/      1;   # 各官方版本的数据文件
  ~^/vs/                 1;   # 视觉插件集的 overlay
  ~^/p/                  1;   # 插件文件（内容寻址）
  =/healthz              1;   # ★ 见下面的「buildGuard 误刷新」
}
```

**`/healthz` 也必须钉住**（2026-10-29 补充）：它的 `build` 同样是每台各算各的
（`buildTag` 覆盖 `index.html` / `js` / `css` / `sim` / `shared` / `data`）。
`public/js/ui/buildGuard.js` 每 60 秒读一次它，判断「服务器是不是换了」：

> 连续两次读到**同一个新** build → 对局外页面自己 reload 一次。

若 `/healthz` 被随机分流到另一台节点，读到不同的 build，页面就会**莫名自动刷新**。
钉住它之后读到的永远是页面自己那台的 build，不会误判。

在 if 链的最后再加一次：

```nginx
if ($sp_is_version_data = 1) { set $sp_node $cookie_sp_route; }
```

**放在最后是关键**：这样它是无条件的，不受第 0 条「未开放 → 随机改派」影响。

只钉这四个前缀，是因为**其余静态资源 30 台完全相同**（`/assets/`、`/js/`、`/css/`、`/mm/` 都是
junction 或共享副本，跨节点取到的是同一份），只有 `/cs/`、`/data/versions/` 这类
**由代码算出来的内容**才会逐节点不同。

维护者的规则没变：**新访客仍然只分到开放节点**；只有「已经在某台节点上的人」，
他的版本数据请求会留在那台。

#### 验证

```powershell
# 修复前：不带参数 → 404
#   https://<站点>/cs/837130125426e9ad/index.json           → 404
# 修复后应为 200（跟随页面那台）
```

语法检查（**不会影响运行中的 nginx**）：

```powershell
D:\Stronghold-Protocol\nginx\nginx.exe -p D:\Stronghold-Protocol\nginx\ -c conf/nginx.conf -t
```

**⚠ 生效必须重启 nginx**（`node tools/restart-nginx.mjs --apply`），`-s reload` 会被拒绝
（nginx 以 SYSTEM 运行，`OpenEvent` Access denied）且会留下 worker。

**✅ 已生效（2026-10-29 20:51，维护者亲自重启）。** 实测：

```
cookie=20 + node-20 的 cs → HTTP 200（3 次全成功）   ← 跟随 cookie，不再被改派
```

对照组也符合预期：`cookie=20` 拿 **node-29 的** cs 仍然 404 ——
因为那确实是跨组，该失败就失败，说明规则是「跟随 cookie」而不是「什么都不拦」。


#### 顺带说明：`cs` 分组本身会随重启消失

两组 `cs` 不同，根因是**节点跑的代码版本不同**（A 组是当时最近重启过的两台）。
等 30 台都重启到同一版代码，`cs` 自然统一。**这条 nginx 修复不依赖它** ——
即使 `cs` 再次分裂，只要请求不跨组，就不会 404。

**2026-10-29 实测已经统一**：30 台的 `content.vanilla` 全部是 `8bc7a0a3bc49d88c`，
`cs` 分裂已消失（node-1 / node-29 都追上了）。

> 但要注意 `build` 字段**不一定**跟着统一 —— `buildTag.js` 用的是
> `[rel, size, mtimeMs]`，内容相同、mtime 不同的节点算出的 build 不同。
> 这不影响玩家（`/healthz` 已跟随页面节点，同一页面的 build 恒定），
> 所以不用为它做任何事。


### 9.15 「已跑最新代码」到底怎么判断（2026-10-28 修正）

控制台那句 **「N / 30 个节点已跑最新代码」** 的判断口径，改过两次，记录在这里免得再走回头路。

#### 参与判定的目录：`server/` **和** `shared/`

这两个目录都是「每个节点各自一份副本，改完必须分发 + 重启才生效」：

| 目录 | 里面是什么 |
|---|---|
| `server/` | 连接、会话、对局逻辑、HTTP 路由 |
| `shared/` | 协议白名单（`protocol.js` 的 `C2S`）、常量、玩法规则 |

`public/` **不算**：那些是浏览器加载的，玩家刷新页面即可，不用重启节点。

> **原来只扫 `server/`。** 后果是：改完 `shared/` 之后控制台照样显示「已跑最新代码」，
> 而节点内存里还是旧的。§9.14 的复活（`g.revive`）就是被这么漏掉的 ——
> 控制台说 24 台最新，逐台实测真正能用的只有 7 台。

#### 判定依据：内容指纹，**不是**文件 mtime

这是第二个坑。**文件 mtime 会被「重新分发同样的内容」刷新**（`Copy-Item` 或手工再复制一遍都会），
于是刚重启、明明已经加载新代码的节点，会因为文件时间变新而被判成「旧代码」。

2026-10-28 实测踩到：node-9/14/22/25 启动于 22:44，复活实测可用，
但 22:47 把同一份文件重新分发了一次，mtime 刷成 22:47，它们立刻被判成旧代码 —— **误报**。

现在的做法（`dashboard/server.js`）：

1. 把 `node-1`（母版）下 `server/` + `shared/` 所有 `.js` 的哈希合成一个**内容指纹**；
2. 只在指纹**真的变了**时才更新标记文件 `content/ops-code-stamp.json`；
3. 判定用标记文件里记的**时刻**，而不是文件系统时间。

重复分发同样的内容不会动这个标记，所以不会再误报。

> 标记文件第一次生成时，会把「现在」记成生效时刻，导致所有节点都被判成旧代码。
> 这时的正确做法是**手工校正** `at` / `kindAt` 为真实生效时刻（本项目 2026-10-28 校正为
> `shared=22:40`（首次分发）、`server=21:18:57`（`lobby.js` 最后变更））。
> 校正完必须**逐台实测验证**，见下。

#### 必须分目录比对，不能取两者的最小值

`server` 是 21:18、`shared` 是 22:40。若统一拿「两者里最旧的那个」去比，
一个 21:30 启动、只加载了旧 `shared` 的节点会被误判成最新（实测 17 台误报）。

规则：**任一目录落后，就算落后**。控制台会把落后的是哪一块写出来：

- 节点卡片上标「差服务端」「差共享代码」「差服务端+共享代码」
- 顶部「代码时间」分开显示两块的时间

#### 验收：必须和逐台实测对得上

推断出来的数字**不算数**。改完判定逻辑后，跑一次全量实测：

```powershell
# 逐台跑，看回复是 unknown type（旧）还是 no running match（新）
node tools\verify-revive.mjs <节点号> <userToken>
```

2026-10-28 全量实测结果与控制台判定**完全一致**：8 台最新（8、9、14、15、22、25、26、30），
22 台落后。其中 6 台落后 `server+shared`（1、2、11、19、21、24），16 台只落后 `shared`。

### 9.14 复活（联防救援）点了没用，提示「无效的请求」（2026-10-28 修复）

玩家反馈（房间 KYEV / 245861980@qq.com）：**没漏怪、生命值也大于 10，点复活却提示「无效的请求」**。

#### 根因：`shared/protocol.js` 的 `C2S` 白名单缺了 `g.revive`

复活的整条链路其实都在，唯独协议白名单漏了一行：

| 环节 | 状态 |
|---|---|
| 客户端按钮 `public/js/ui/revival.js` | 有，发 `g.revive {playerId, round, matchId}` |
| `Match.revive()` 资格复核（`server/match/Match.js`） | 有，逻辑完整 |
| `intents.js` 里的 `case 'g.revive'` | 有 |
| **`shared/protocol.js` 的 `C2S` 白名单** | **缺 —— 这就是 bug** |

`server/net.js` 在把请求交给对局之前，先查白名单：

```js
if (!Object.hasOwn(C2S, msg.t)) { ... errorMsg(ERR.BAD_MSG, rid, `unknown type ${t}`); return; }
const reason = validateC2S(msg);
if (reason) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, reason)); return; }
```

请求在**门口**就被打回去了，**根本走不到 `Match.revive`**，所以：
`ERR_TEXT.BAD_MSG = 无效的请求`。

**这解释了反馈里那个「奇怪」的地方**：不管玩家有没有漏怪、生命值是不是 11 以上，
结果永远是「无效的请求」—— 因为那两个条件属于 `Match.revive` 内部的判断，
请求压根没到那里。玩家说的「没漏怪」「大于 10 血」都是真话，只是这些资格判断从来没被读到。
（顺带：`REVIVAL_MIN_DONOR_LP = 11`，付 10 点所以至少 11，玩家说的「大于 10」对得上。）

#### 这行是怎么丢的

git 历史：`d4711139`「同步 node-1 游戏本体」**加过**这一行，之后上游同步时被抹平了。
补丁体系里 `patcher/features/server-player-capacity/` 下有两份 `protocol.js`：

- `base/shared/protocol.js` —— **有** `g.revive`，但那是旧快照，不是实际应用的
- `files/shared/protocol.js` —— **没有**，这份才是真正被应用的

上游 0.3.3 本身没有联防救援，同步时就把这一行当成「差异」清掉了。

#### 修复

`files/shared/protocol.js` 与 `shared/protocol.js` 都补上（位置与 `base/` 一致，在 `g.ready` 之后）：

```js
'g.revive': { playerId: isId, round: (v) => isInt(v, 1, 1000), matchId: isId },
```

**⚠ 改完必须重启节点才生效**（`shared/` 属于「重启生效」那一类，玩家刷新页面不够）。

#### 怎么验证修好了

`tools/verify-revive.mjs`（传入节点号与 accountToken）：

```powershell
node tools\verify-revive.mjs 9 <userToken>
```

判定看**回复的错误码**，不用真打完一局：

| 回复 | 含义 |
|---|---|
| `BAD_MSG` / `unknown type g.revive` | **没修好**，还堵在协议层 |
| `WRONG_PHASE` + `detail: "no running match"` | **修好了**，已穿过协议层进到对局逻辑（空房间没开局，返回这个是正常的） |

2026-10-28 实测：node-9 上修复后返回 `WRONG_PHASE / no running match`，判定通过。

#### 教训：新增协议消息必须过两道关

本服每加一个 `g.*` / `room.*` 消息类型，**除了写客户端和对局逻辑，还必须加进 `C2S` 白名单**。
只加两头不加中间，表现就是「按钮点了没反应 / 提示无效的请求」，而且日志里看不出是白名单的问题
（detail 里的 `unknown type` 只发回客户端，不写服务端日志）。

### 9.13 控制台「关闭房间」——讲清楚为什么关不掉（2026-10-28 新增）

控制台（`dashboard :3080`）的房间表里加了「关闭」按钮，走的是节点侧的
`POST /admin/room/close`（`server/http/routes.js`）。这条路**踩过一次坑**：

> 节点还没重启到带这条路由的代码时，`POST /admin/room/close` 会掉进静态文件兜底，
> 返回 `405` + 一张 HTML 错误页。控制台只显示一句「关闭失败」，完全猜不到原因，
> 会让人误以为是权限或房间号的问题。

现在的处理分两层：

| 层 | 做法 |
|---|---|
| 先判断能不能关 | `dashboard/server.js` 的 `roomCloseCapable(n)`：比对 pm2 的 `pm_uptime` 与 `node-N/server/http/routes.js` 的 mtime，旧代码直接返回 `409 node_not_ready` + 中文说明，**不发无效请求** |
| 万一还是 405 | `explainCloseError(status, body, nodeN)` 统一翻译成「node-N 还没重启到最新代码…需要重启一次」 |

**口径与运维区一致**：`/api/ops/state` 的 `fresh` 字段也是「进程启动时间 ≥ 最新代码 mtime」，
不存在两套判断。**读不到启动时间时一律放行**（`ok:true`）—— 宁可让它自然报 405，
也不能因为查不到就凭空拦住维护者。

前端 `dashboard/public/app.js` 优先显示服务端给的 `hint`，并把 toast 延长到 6 秒。

**这说明的是一个总规律：`server/` 下的改动没在节点上重启，就等于没改。**
刚部署完新功能那一段时间，控制台会如实告诉你哪些节点还没跟上：

```powershell
# 哪些节点的 server/ 代码比进程新（需要等它空闲后重启一次）
(Invoke-RestMethod http://127.0.0.1:3080/api/ops/state).nodes |
  Where-Object { -not $_.fresh } | ForEach-Object { "node-$($_.n) matches=$($_.matches)" }
```

`matches > 0` 的节点**绝对不能重启**，交给计划任务 `SP-Rolling-Restart`（每 10 分钟）
在对局结束、节点空闲时自己补上。

### 9.8 提交前最终检查

```powershell
cd D:\Stronghold-Protocol\repo-sync
git rev-list --left-right --count origin/custom/production...HEAD   # 必须是 0  0
node patcher/check-coverage.mjs                                     # 未进补丁: 0
git status --short                                                  # 无意外文件
```

推送后必须**重新 fetch**，否则本地跟踪引用会过期：

```powershell
$tok = (Get-Content D:\Stronghold-Protocol\.secrets\github-token.txt -Raw).Trim()
$url = "https://x-access-token:$tok@github.com/SatsumaUton/Stronghold-Protocol.git"
# 直连 + HTTP/1.1，见下面「镜像全挂时怎么办」
git -c http.version=HTTP/1.1 -c credential.helper= -c http.postBuffer=524288000 `
    push  $url refs/heads/custom/production:refs/heads/custom/production
git -c http.version=HTTP/1.1 -c credential.helper= `
    fetch $url refs/heads/custom/production:refs/remotes/origin/custom/production --force
git rev-list --left-right --count origin/custom/production...HEAD   # 再确认一次 0  0
```

#### 镜像全挂时怎么办（2026-10-31 实测）

那天 `ghfast.top` 连续十几次超时（21 秒后 `Failed to connect`），直连也报
`Recv failure: Connection was reset`，一度以为推不上去。逐个试出来的结论：

| 通道 | 结果 |
|---|---|
| `ghfast.top` | 连接超时，全程不可用 |
| `gh-proxy.com` | **读可以、写不行**：`remote: No anonymous write access.` |
| `gitclone.com` | 只读镜像，不认 token |
| `hk.gh-proxy.com` | HTTP 超时 20s |
| **直连 `github.com` + HTTP/1.1** | ✅ 成功（`ls-remote` 1.8s，30 个提交直接推完） |

关键有两条：

1. **`-c http.version=HTTP/1.1`** —— 这道改动让直连从「21 秒超时」变成「1.8 秒通」。
   默认协商的 HTTP/2 在这条链路上会被卡住。
2. **token 必须拼在 URL 里**（`https://x-access-token:$tok@github.com/...`），
   用 `http.extraHeader="Authorization: Bearer ..."` 反而会走到凭据提示，
   报 `could not read Username`。

> ⚠ **千万别加 `-c http.postBuffer=...`**（2026-10-31 又踩一次）。
> 同一个时刻，`ls-remote` 2.2 秒就通、说明网络是好的，但带 `postBuffer=524288000`
> 的 `push` 依然 `Failed to connect after 21020 ms`；去掉这个参数、只留
> `-c http.version=HTTP/1.1 -c credential.helper=` 后**立刻推成功**。
> 那个参数本来是给「大提交卡住」准备的，在这条链路上反而让连接建不起来。
> 最小可用的推送命令行就是：
>
> ```powershell
> git -c http.version=HTTP/1.1 -c credential.helper= push $url HEAD:custom/production
> ```

> 判断「连不连得上」不要用 `Test-NetConnection`：它只测 TCP 握手，
> 那天它对 `ghfast.top:443` 报 `True`，但 TLS/HTTP 层根本走不通。
> 真判据是 `git ls-remote <url> HEAD` 能不能在几秒内返回。

#### ⚠ 判断「推送成功没有」不要看 `origin/custom/production`

本仓库 `remote.origin.fetch` 只配了 `master`：

```
+refs/heads/master:refs/remotes/origin/master
```

所以 `origin/custom/production` 这个本地跟踪引用**从来不会自动更新**——`git push` 明明成功了
（输出里能看到 `a6d15a79..9f54921b  custom/production -> custom/production`），
`git fetch origin custom/production` 也成功了，但 `git rev-parse origin/custom/production`
仍然停在很久以前的旧提交。**拿它判推送结果是假警报**，2026-10-31 就被它误导过一次。

唯一可信的判据是直接问远端：

```powershell
git ls-remote origin refs/heads/custom/production   # 输出必须等于 git rev-parse HEAD
```

`git rev-parse FETCH_HEAD` 只在刚 fetch 完的那一刻有效，也可靠，但不直观。
想一劳永逸就把 refspec 补上（可选）：

```powershell
git config --add remote.origin.fetch '+refs/heads/custom/production:refs/remotes/origin/custom/production'
```

## 十、安全与红线

1. `.secrets/`、`matchmaker/public/admin.html` 不上传 GitHub（`admin.html` 已被上游 `.gitignore` 排除）；
2. 代码与文档不写明文密码、不写明文 GitHub PAT；
3. 管理后台必须走邮箱二次验证，不要绕过；
4. 审计日志只追加不修改；
5. 重启节点前先确认 `matches = 0`，避免影响对局；
6. 改 `lobby.js` 前先备份（历史上批量删除曾误伤 5 处）；
7. **仓库是公开的**：提交前确认没有本机绝对路径、Windows 用户名、真实凭据；
8. 发现凭据曾进入过 Git 历史时，先撤销该凭据再谈清理历史（重写历史会改变 commit 哈希）。
