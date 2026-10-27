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
| `map $cookie_sp_route $sp_cookie_open { … }` | cookie 指向的节点是否开放；`0` 会被重新分流 |
| 已就位的 `location /` 分支 | cookie 指向开放节点才粘住；带房间上下文时强制回原节点 |

```powershell
# 改完必须验证 + 重载（nginx 会先 -t 校验，写错不会生效也不会中断服务）
.\nginx\nginx.exe -t -c "$PWD\nginx\conf\nginx.conf" -p "$PWD\nginx"
.\nginx\nginx.exe -s reload -c "$PWD\nginx\conf\nginx.conf" -p "$PWD\nginx"
```

**验证办法**：带一个受限节点的 `sp_route` cookie 访问站点，看响应头 `X-SP-Node`
是不是被改派到了开放节点；再用开放节点的 cookie 确认它被粘住。

```powershell
$r = Invoke-WebRequest "https://stronghold.luobomiao.love/" -UseBasicParsing -Headers @{ Cookie = "sp_route=9" }
@($r.Headers['X-SP-Node'])[0]     # 不应是 9
```

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
| 旧 `sp_route` cookie 指向它 | ❌ 会被重新分流到开放节点 |
| **房间里已有的玩家继续游玩** | ✅ **完全不受影响** |
| **房间直连**（`?room=CODE`、`n=`、`adminWatch=1`） | ✅ **强制回原节点，绝不切走** |
| 打完后在房间里再开一局 | ✅ 可以 |

**第四步：等对局自然结束后，重复第一步**，把空出来的节点重启、加回开放列表。

**验证是否真的生效**

```powershell
# 匹配器启动日志应打印
Get-Content logs\matchmaker.out-*.log -Tail 5 | Select-String "暂停接收新玩家"

# 带受限节点 cookie 访问，应被改派到开放节点
$r = Invoke-WebRequest "https://stronghold.luobomiao.love/" -UseBasicParsing -Headers @{ Cookie = "sp_route=20" }
@($r.Headers['X-SP-Node'])[0]     # 不应是 20

# 房间直连必须仍回原节点
$r = Invoke-WebRequest "https://stronghold.luobomiao.love/?n=20" -UseBasicParsing -Headers @{ Cookie = "sp_route=2" }
@($r.Headers['X-SP-Node'])[0]     # 必须是 20
```

**第五步：全部节点更新完**，把 nginx 的 `split_clients` 恢复成 30 个节点各 3.33%、`$sp_cookie_open` 全部记 `1`，再 `nginx -t` + `-s reload`。

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

#### 这一轮的标准流程（照做即可）

```powershell
# 1) 找出空闲节点（matches=0）
& tools\_restart-when-idle.ps1

# 2) 重启（它自己会再复查一次 matches）
& tools\_restart-when-idle.ps1 -Apply

# 3) 重建开放列表（只改 nginx）
& tools\_set-open-nodes.ps1
```

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
| `deploy\_start-pm2.ps1` | 以 SYSTEM 身份启动/恢复 pm2，幂等（已在跑就不重复启动） |
| `deploy\_stack-watchdog.ps1` | 每 2 分钟的看门狗，**现在会自动修复**而不只是报警 |
| `deploy\server-watchdog.ps1` | 计划任务 `Stronghold-Server-Watchdog` 用 |
| `logs\stack-watchdog.log` | 看门狗的处置记录（`PM2 daemon is down -> resurrect` 等） |
| `logs\pm2-resurrect.log` | `_start-pm2.ps1` 的日志 |

**绝不能**因为节点不在开放列表就把 `sp_route` cookie 改派走——那会让正在对局的玩家断线重连后
回不到原节点，表现为「回不到对局」。`sp_route` 必须无条件尊重，开放列表只管没有 cookie 的新访客。

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
$url = "https://x-access-token:$tok@ghfast.top/https://github.com/Jackcharled/Stronghold-Protocol.git"
git push   $url refs/heads/custom/production:refs/heads/custom/production --force
git fetch  $url refs/heads/custom/production:refs/remotes/origin/custom/production --force
git rev-list --left-right --count origin/custom/production...HEAD   # 再确认一次 0  0
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
