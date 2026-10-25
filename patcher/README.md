# 补丁包（patcher）

这里保存「匹配功能 + 三项防护」对**游戏服务端**的两处改动，以及一键还原/重打脚本。

涉及的游戏文件只有两个：

| 文件 | 改了什么 |
|---|---|
| `server/lobby.js` | 同 IP 建房上限、AI 队友上限、挂机踢人（活动时间戳 + 每 20 秒扫描） |
| `server/http/config.js` | 把 `maxBotsPerAddr`、`idleKickMs` 加进 lobby 可配置项 |

其余功能（匹配服务、界面注入、nginx、PM2、管理面板）都在游戏目录之外，更新游戏不会碰它们。

## 目录

```
patcher\
├─ orig\                   官方原版文件（哈希与 MANIFEST.json 一致，用于还原）
│  └─ server\...
├─ apply.mjs               按「锚点」把改动重新插进当前版本源码（幂等）
└─ restore.mjs             把两个文件换回官方原版
```

## 两个一键脚本（在仓库根目录）

| 脚本 | 作用 |
|---|---|
| `apply-patch.bat` | 打补丁（8 处改动）→ 同步到 node-1…node-30 → 重启 PM2 |
| `restore-patch.bat` | 还原官方文件 → 重启 PM2（还原后与 MANIFEST 完全一致） |

## 官方更新时的标准流程

1. 双击 **`restore-patch.bat`** —— 两个文件恢复官方版本，`MANIFEST.json` 校验通过；
2. 按官方方式应用更新包（服务器能正常启动）；
3. 双击 **`apply-patch.bat`** —— 在新版本源码上重新打上 8 处改动并重启。

> 补丁是**按锚点插入**的，不覆盖整份文件，所以新版本里的其它改动都会保留。
> 如果新版本改动了这些锚点，`apply-patch.bat` 会在写文件**之前**中止，并打印是哪一条改动找不到锚点——这时把错误发出来即可，我按新结构更新补丁。

## 单独使用（命令行）

```powershell
node patcher\apply.mjs           # 打补丁
node patcher\apply.mjs --check   # 检查是否已全部打好（不改文件）
node patcher\restore.mjs         # 还原
node patcher\restore.mjs --check # 检查是否已是官方原版
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
