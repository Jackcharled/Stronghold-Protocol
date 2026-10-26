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
