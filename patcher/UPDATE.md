# 上游更新维护流程

完整维护方式见 [MAINTENANCE.md](MAINTENANCE.md)，仓库同步规则见 [REPO-SYNC.md](REPO-SYNC.md)。

**每次更新前必须确认 master 没有落后 upstream；出现 `N commits behind` 时先同步，不允许继续发布。**

目标：以后官方每次发 0.3.x 更新，不重复做整文件三方合并。

## 分层

```text
官方基板        0.3.2 / 0.3.3 更新包
  ↓
服务端锚点补丁  patcher/apply.mjs
  ↓
客户端功能移植  按 patcher/features.json 逐项记录
  ↓
部署层          matchmaker / nginx / PM2 / dashboard / 账号系统
```

## 新增的维护设定

### 1. 功能清单

`patcher/features.json` 记录每项本服功能：

- 功能 id
- 状态：`ported` / `pending-port` / `patcher` / `custom-outside-upstream`
- 涉及文件
- 必测项

以后更新时先看这个清单，不再靠记忆判断哪些文件被改过。

### 2. 单节点/staging 参数

`patcher/apply.mjs` 新增：

```text
SP_BASE=staging/upstream-0.3.3   # 操作哪个基目录
SP_NODE_LIST=1                    # 只写 node-1，默认 1..30
```

staging 检查：

```powershell
$env:SP_BASE='D:\Stronghold-Protocol\staging\upstream-0.3.3'
$env:SP_NODE_LIST='1'
node patcher\apply.mjs --dry
```

正式应用前必须：

1. 备份
2. 先只写 node-1
3. 跑测试
4. 再写全部节点
5. 只重启无对局节点

### 3. 标准更新顺序

```text
备份
→ staging 应用官方更新包
→ 运行 patcher 锚点补丁
→ 逐项移植 features.json 里 pending-port 的客户端功能
→ 语法/导入检查
→ 单节点 smoke test
→ 全节点
```

不要反过来先改生产文件再补备份。

## 0.3.2 / 0.3.3 基线验收

已单独建立两个干净基线：

```text
staging/upstream-0.3.2/node-1        version 0.3.2
staging/upstream-0.3.3-clean/node-1  version 0.3.3
```

验收结果：

```text
0.3.2 更新文件 1097 个，SHA256 不匹配 0
0.3.3 更新文件 21 个，SHA256 不匹配 0
```

说明 0.3.2 不是“跳过”，而是完整应用并校验后，0.3.3 再在它上面递增。本服功能统一在 0.3.3 上移植一次，避免在 0.3.2 和 0.3.3 各做一遍。

## 本次 0.3.3 的结论

已确认现有服务端锚点在 0.3.3 上仍能命中：

```text
lobby-defaults
idle-timer
idle-shutdown
activity-stamp
idle-sweep-methods
bot-cap
count-bots
lobby-option-keys
```

说明挂机防护、同 IP 上限、AI 上限、快照/检查点不需要重写。

仍需移植的是：

```text
server/lobby.js       组队匹配、游客限制、座位回收
public/js/main.js     Build Guard/隐藏观战/账号恢复（已开始）
public/js/screens/lobby.js
public/js/screens/room.js
```

## 2026-10-25 移植进度

已完成并通过语法检查：

```text
server/lobby.js
  - 挂机防护/同 IP 上限/AI 上限（原有锚点）
  - room.matchmaking 状态、分发、方法、暂停解散计时
  - 游客建房限制
  - 管理员房间 adminCreated/noExpire
  - Room.capacity / 5–20 人实验选项 / room.setExperimental
  - 4→8 扩容和已占座位时缩容拒绝已测试

public/js/main.js
  - Build Guard 禁止自动刷新
  - 隐藏观战重连不丢房间
  - 账号恢复参数清理
  - 隐藏观战跳过 pending join

public/js/screens/lobby.js
  - 游客不能创建独立/同盟房间提示

public/js/screens/room.js
  - 按 room.capacity 扩展座位数
  - 5–20 人 seats--expanded 网格/滚动布局
  - maxSpectators 与隐藏观战状态
  - 实验设置面板（4–20 人/复活/独立卡池/禁鸭爵/重复策略）

public/js/screens/game.js
  - manyPlayers / gm--expanded 对局布局
```

仍需：

```text
public/js/screens/room.js       观战上限/隐藏观战 UI 细节
server/lobby.js                 20 人容量与实验房、座位回收、账号恢复完整链路
matchmaker/mm client            匹配与公告
```

生产未部署，所有改动仅在 `staging/upstream-0.3.3`。

## 回滚

- 代码备份：`backups/pre-upstream-20261025-134242`
- 官方文件还原：`node patcher\restore.mjs`
- 生产当前仍是 0.3.1 + 本服补丁，未部署 0.3.3
