# 本服更新操作规约

用于避免再次出现工具流式 JSON 失败导致的重复工作。

## 硬规则

1. 一次工具调用只做一件事。
   - 不把读文件、改多个文件、跑测试、重启节点塞进同一个调用。
2. 不在命令行里内联大段 JS/PowerShell。
   - 脚本先写到文件，再 `node file.mjs` / `pwsh -File file.ps1`。
3. 单次工具参数尽量控制在 2KB 以内。
   - 大文件用 `write` 分块创建，或 `edit` 小块修改。
4. 改文件前先备份。
5. 只改 staging，不直接改生产 `node-1`。
6. 每个文件改完立即 `node --check`。
7. 每个功能改完立即在 staging 做小测试。
8. 测试通过之前不写 30 个节点、不重启。
9. 任何锚点缺失立即停止，不写半套补丁。
10. 生产部署只走：备份 → 单节点 → smoke test → 全节点 → 只重启空闲节点。
11. 每次发布前必须确认仓库已包含 upstream：
    ```bash
    git fetch upstream
    git merge-base --is-ancestor upstream/master HEAD
    node patcher/check-repo-sync.mjs
    ```
    失败则禁止发布，不允许继续累积分叉。
12. 不允许用强推或假合并消除 behind 数字。

## 标准执行顺序

```text
确认当前版本和备份
→ git fetch upstream 并确认没有落后
→ 在 staging 应用官方补丁
→ 校验 SHA256
→ 用 patcher 锚点移植服务端功能
→ 用 edit 小块移植客户端功能
→ node --check
→ 功能级小测试
→ 记录 features.json / MERGE-STATUS
```

## 不再做的事

- 不再用三方合并整文件覆盖上游基板
- 不再一次改 10 个文件
- 不再先部署再补验证
- 不再在复杂命令里拼接大量中文和引号

## 当前断点

```text
staging/upstream-0.3.3/node-1
```

已完成：

- 0.3.2 独立基线验收
- 0.3.3 独立基线验收
- patcher 锚点机制和单节点参数
- 游客建房限制
- room.matchmaking
- main.js Build Guard/隐藏观战/账号恢复
- room.js 5–20 人布局和容量字段读取
- 服务端 Room 容量字段/toState 容量字段

未完：

- create 的 experimental 参数
- 5–20 人实验设置面板
- 20 人匹配/开局完整测试
- matchmaker 客户端
