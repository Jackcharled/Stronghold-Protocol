# 卫戍协议 · 运维维护手册（2026-10-20）

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
| 节点分配 | 匹配服务按负载选择节点；客户端通过 `sp_route` cookie 固定上游，`sp_node` 供前端读取（pin 时两个 cookie 一起写） |
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
