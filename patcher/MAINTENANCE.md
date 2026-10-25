# 功能补丁维护说明

这份文档给以后维护用。目标：上游 0.3.x 再更新时，不整文件重做本服功能，并且仓库永远可以直接同步上游。

## 维护总原则（先看）

### 分支职责

```text
master：
  只跟随 sganggs/Stronghold-Protocol。
  不含本服功能，永远保持 behind = 0。

custom/production：
  本服完整代码和补丁。
  每次上游更新后合并 upstream/master，同样保持 behind = 0。
```

### 本服功能放哪里

```text
patcher/apply.mjs          服务端锚点补丁
patcher/features/          功能快照
patcher/merge-features.py  功能级三方合并
```

不要把本服功能直接提交到 master；master 只同步上游。

### 每次上游更新的固定动作

```text
1. git fetch upstream
2. master 合并 upstream/master
3. custom/production 合并 upstream/master
4. 运行 node patcher/check-repo-sync.mjs
5. 只处理真实冲突
6. 跑测试
7. 发布
```

### 发布前硬检查

```powershell
node patcher\check-repo-sync.mjs
```

返回非 0 时禁止发布。

### 绝对禁止

```text
长期不合并上游
让 behind 累积到几十/几百
在 master 上直接开发本服功能
强推受保护的 master
用假合并消除 behind 数字
用整文件覆盖代替补丁
```

### 如果已经落后

```text
先建 backup 分支
→ 创建 sync/upstream-日期 分支
→ 合并 upstream/master
→ 解决冲突
→ PR 合并回 master
→ 再更新 custom/production
```

不允许绕过，不允许直接忽略。

## 目录

```text
patcher/
  features.json          功能清单：id、文件、测试项、状态
  features/
    <功能id>/
      base/              上游 v0.3.1 基线文件
      files/             本服当前功能文件
    index.json
  apply.mjs              服务端锚点补丁（挂机/匹配/游客/容量等）
  snapshot-features.mjs  从当前 node-1 重新导出功能快照
  merge-features.py      把功能快照与新版上游做三方合并
  update.md / 本文档
```

## 两种补丁

### 1. 服务端锚点补丁

`patcher/apply.mjs` 按锚点插入，不覆盖整文件。

```powershell
$env:SP_BASE='D:\Stronghold-Protocol\staging\upstream-0.3.3'
$env:SP_NODE_LIST='1'
node patcher\apply.mjs --dry
node patcher\apply.mjs
```

`SP_NODE_LIST=1` 只写 node-1；正式发布再写全部。

### 2. 功能快照三方合并

`patcher/features/` 里每个功能保存：

- `base/`：上游 v0.3.1 原文件
- `files/`：本服功能文件

新版上游到来时：

```powershell
python patcher\merge-features.py `
  --upstream D:\Stronghold-Protocol\staging\upstream-0.3.3-clean\node-1 `
  --out D:\Stronghold-Protocol\staging\features-merged
```

输出：

```text
staging/features-merged/
  report.json      每个文件的状态和冲突数
  合并后的文件
```

状态：

```text
upstream-only   只上游改了，自动用上游
custom-only     只本服改了，自动用本服
merged          两边都改但已自动合并
conflict        需要人工处理
```

## 标准更新流程

```text
1. 备份
2. 应用官方更新到 staging（0.3.2 → 0.3.3，逐步校验 SHA256）
3. 运行 patcher/merge-features.py
4. 看 report.json，只处理 conflict 文件
5. 服务端跑 patcher/apply.mjs
6. node --check
7. 房间/匹配/游客/观战/5–20 人测试
8. 单节点
9. 全节点
10. 只重启无对局节点
```

不要：

```text
整包覆盖 node-1
直接覆盖 public/js
直接覆盖 server/lobby.js
先部署再补测试
```

## 新增一个本服功能

1. 在 `patcher/features.json` 增加条目：

```json
{
  "id": "feature-id",
  "name": "功能名",
  "files": ["public/js/...", "server/..."],
  "tests": ["测试项"]
}
```

2. 运行：

```powershell
node patcher\snapshot-features.mjs
```

3. 只提交：

```text
patcher/features/<id>/
patcher/features/index.json
patcher/features.json
```

以后上游更新自动把该功能和上游新代码做三方合并。

## 修改已有本服功能

1. 改 `node-1` 里的功能代码
2. 重新跑：

```powershell
node patcher\snapshot-features.mjs
```

3. 检查 `patcher/features/<id>/files` 是否更新

## 处理冲突

只处理 `report.json` 里 `status: "conflict"`：

- 上游重构占主导：采用上游结构，把本服逻辑插入对应函数
- 本服功能占主导：保留本服结构，把上游新增字段/方法补进来
- 不整段删除本服逻辑

当前已知高冲突：

```text
server/lobby.js
public/js/screens/loadout.js
public/js/screens/room.js
public/js/screens/settle.js
public/js/screens/game.js
public/js/screens/lobby.js
```

## 当前版本状态

- 生产：当前本服版本，未部署 0.3.3
- staging：0.3.2/0.3.3 基线和合并实验
- 功能快照：151 个文件，12 个功能
- 测试命令：`staging/upstream-0.3.3/node-1/test-stage-custom.mjs`

## 依赖

`merge-features.py` 需要：

```powershell
python -m pip install merge3
```

`node --check` 不需要额外依赖。

## 仓库同步（必须遵守）

### 发生过的问题

本服 fork 曾长期不合并上游，出现：

```text
25 commits ahead of and 488 commits behind sganggs/Stronghold-Protocol:master
```

结果：

- GitHub「Sync fork」返回 `409 Conflict`
- master 有分支保护，不能强推
- 无法直接同步，只能重新做大量合并

### 硬规则

1. 每次上游发布后**立即同步**，不允许累计几十上百个提交。
2. `master` 必须包含 `upstream/master`。
3. 本服功能只走：
   ```text
   patcher/apply.mjs
   patcher/features/
   patcher/merge-features.py
   ```
   不长期直接改上游原文件。
4. 合并前必须建备份分支：
   ```bash
   git branch backup/pre-upstream-YYYYMMDD
   ```
5. 发布前必须检查：
   ```bash
   git fetch upstream
   git merge-base --is-ancestor upstream/master HEAD
   ```
   返回非 0 时禁止发布。
6. 不允许用 `git push --force` 覆盖受保护的 master。
7. 不允许用假合并（只把 upstream 设为父提交但不带入代码）来消除 behind 数字。

### 标准流程

```bash
git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git
git fetch upstream
git checkout -b sync/upstream-YYYYMMDD
git merge upstream/master
# 解决真实冲突后
git add <冲突文件>
git commit
git push origin sync/upstream-YYYYMMDD
# 通过 PR 合并回 master
```

合并后再次执行：

```bash
git merge-base --is-ancestor upstream/master HEAD
```

通过才算同步完成。

也可以直接运行检查脚本：

```powershell
node patcher\check-repo-sync.mjs
```

返回 0 才能发布。

### 当前仓库状态

```text
GitHub master：2909f15b
  纯上游 0.3.3
  behind upstream/master = 0

GitHub custom/production：7267e716
  本服完整功能
  behind upstream/master = 0

备份分支：backup/pre-upstream-merge-20261025
同步分支：sync/upstream-20261025
```

2026-10-25 已完成真实合并，并把 master 恢复为纯上游内容。以后 master 只同步上游，本服功能在 custom/production。

## 事故复盘：为什么会出现 488 behind

当时 master 同时承担“上游同步”和“本服开发”，25 个本服提交长期没有合并上游，最终：

```text
25 ahead / 488 behind
GitHub Sync fork 409 Conflict
master 分支保护禁止强推
```

正确做法就是现在的结构：

```text
master       = 上游镜像
custom/...   = 本服开发
patcher/     = 功能补丁
```

以后只要发现 behind > 0，立即停止开发并同步，不允许继续累积。


