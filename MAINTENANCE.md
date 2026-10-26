# 卫戍协议 · 运维维护手册（2026-10-26）

> 新会话接手必读。本文件覆盖：整体架构、30 节点、管理后台、数据库、控制台、日常运维、故障排查。
> 配套文档：`docs/HANDOFF-2026-10-20.md`（开发交接）、`docs/GITHUB-RULES.md`（上传规则）。

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
| `MM_EXPERIMENTAL_NODE` | 5–20 人大厅专用节点，默认 `4`。**这个节点必须在开放列表里**，否则多人大厅开不出来 |
| `MM_DISABLED_NODES` | 暂停接收新玩家的节点，逗号分隔，如 `1,3,9`。见下节 |

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

**第三步：把有玩家的节点从「对外开放」里摘掉（改两处！）**

| 位置 | 改什么 |
|---|---|
| `ecosystem.config.cjs` → `matchmaker.env.MM_DISABLED_NODES` | 写上受限节点号 |
| `nginx/conf/nginx.conf` → `split_clients $sp_rand_node` | **只保留开放节点**，权重按数量等分 |
| `nginx/conf/nginx.conf` → `map $cookie_sp_route $sp_cookie_open` | 受限节点记 `0`，开放节点记 `1` |

```powershell
# 匹配器
pm2 startOrReload ecosystem.config.cjs --only matchmaker --update-env
pm2 save
# nginx
.\nginx\nginx.exe -t -c "$PWD\nginx\conf\nginx.conf" -p "$PWD\nginx"
.\nginx\nginx.exe -s reload -c "$PWD\nginx\conf\nginx.conf" -p "$PWD\nginx"
```

> ⚠️ **只改其中一处是不够的**，两条入口各管一半：
> - `MM_DISABLED_NODES` 只管**匹配器组队时挑哪个节点**
> - `split_clients` / `sp_cookie_open` 管**新玩家登录进哪个节点**（nginx 静态分流）
>
> 漏掉 nginx 那份，新玩家照样会被随机分进正在维护的节点。

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

**第五步：全部节点更新完**，把 `MM_DISABLED_NODES` 置空、
`split_clients` 恢复成 30 个节点各 3.33%、`$sp_cookie_open` 全部记 `1`。

> 当前进度与每次的节点清单记录在仓库根目录 `PENDING-RESTART.md`。

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
| **某节点要重启但还有人在玩** | 先把节点号加进 `MM_DISABLED_NODES` **和** nginx 的 `split_clients`/`sp_cookie_open`，等它空下来再重启 |
| **放开一个节点** | 从上面两处同时移除，`pm2 startOrReload ... matchmaker --update-env` + `nginx -s reload` |
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
| 新玩家还进维护中的节点 | `split_clients` 与 `$sp_cookie_open` 是否同步改了 | 两处都要改（见「重启窗口期」），改完 `nginx -t` + `-s reload` |
| 改了 `MM_DISABLED_NODES` 没生效 | 是否用了 `pm2 restart` | 必须 `pm2 startOrReload ... matchmaker --update-env`，再 `pm2 save` |
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

## 九、安全与红线

1. `.secrets/`、`admin.html`、`account.cjs` 不上传 GitHub（见 `GITHUB-RULES.md`）；
2. 代码与文档不写明文密码；
3. 管理后台必须走邮箱二次验证，不要绕过；
4. 审计日志只追加不修改；
5. 重启节点前先在控制台确认在线人数，避免影响对局；
6. 改 `lobby.js` 前先备份（历史上批量删除曾误伤 5 处）。
