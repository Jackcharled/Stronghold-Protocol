# 仓库同步规范

目标：不再出现：

```text
25 commits ahead of and 488 commits behind sganggs/master
```

## 分支

```text
upstream/master          只读，跟随 sganggs
master                   本服发布分支，必须包含 upstream/master
custom/production        可选长期分支，同样必须包含 upstream/master
backup/*                 合并前快照
```

## 硬规则

1. 每次上游发布后，先同步，不继续积累分叉。
2. `master` 必须能快进或合并 upstream/master。
3. 本服功能放 `patcher/` 和 `custom/`，不长期改上游原文件。
4. 合并前必须创建 `backup/<日期>` 分支。
5. 合并后必须跑：

```bash
git fetch upstream
git merge-base --is-ancestor upstream/master HEAD
```

返回 0 表示已包含上游；返回非 0 禁止发布。

## 标准命令

```bash
git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git
git fetch upstream
git checkout master
git branch backup/pre-upstream-合并日期
git merge upstream/master
```

有冲突时：

```bash
git status
# 只解决真正冲突的文件
git add <冲突文件>
git commit
```

不要：

```text
git checkout --theirs .
git reset --hard upstream/master
直接删除本服文件
长期不合并继续开发
```

## 发布检查

```powershell
git fetch upstream
git merge-base --is-ancestor upstream/master HEAD
if ($LASTEXITCODE -ne 0) { throw '仓库未包含最新上游，禁止发布' }
```

## 补丁层

本服功能通过：

```text
patcher/apply.mjs
patcher/features/
patcher/merge-features.py
```

重新应用，避免把大量自定义直接提交到上游文件。

## 当前状态

```text
GitHub master：2909f15b
  纯上游 0.3.3，behind upstream/master：0

GitHub custom/production：7267e716
  本服完整功能，behind upstream/master：0

备份分支：backup/pre-upstream-merge-20261025
本机 Git：2.56.0.windows.3
```

2026-10-25 已完成真实合并，并把 master 恢复为纯上游内容；本服功能全部放在 `custom/production` 和 `patcher/`。

以后 master 只同步上游，不再直接开发，因此不会再出现无法直接同步的情况。
