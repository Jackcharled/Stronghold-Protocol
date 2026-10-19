# 服务端补丁 · 2026-10-20

本目录保存本次本地部署的服务端改动快照，便于后续维护时对照 / 回滚 / 重新应用。

## 改动清单

| 文件 | 说明 |
|---|---|
| node-*/server/lobby.js | 房间计时：`roomTtlMs()` 读配置、建房冻结 `room.ttlMs`、`toState` 下发 `serverNow/expiresInMs/ttlMs`、sweep 用房间自身时长、join 不重置 |
| node-*/server/persist/lobbyState.js | 存档增加 `createdAt / lastMatchEndedAt / ttlMs`，恢复优先用存档值 |
| matchmaker/server.js | 新增 `GET /mm/api/room-ttl` |
| dashboard/server.js | 新增 `GET/POST /api/room-ttl`（写 shared/data/room-ttl.json） |
| dashboard/public/* | 后台「同盟解散时间」设置区块与读写脚本 |
| ecosystem.config.cjs | `BASE` 指向新目录；每节点 `SP_REDIS_PREFIX=sp:n<N>:` |
| matchmaker/public/client.js | 倒计时按房间 ttlMs、5 秒同步配置、加房不重置 |
| shared/data/room-ttl.json | `{ "minutes": 15 }`，后台可改 |

## 应用顺序（新机器 / 重建时）

1. 覆盖 `node-*/server/lobby.js` 与 `node-*/server/persist/lobbyState.js`（30 个节点都要）；
2. 覆盖 `matchmaker/server.js`、`dashboard/server.js`、`dashboard/public/app.js`、`dashboard/public/index.html`；
3. 覆盖 `ecosystem.config.cjs` 后 `pm2 delete all && pm2 start ecosystem.config.cjs`；
4. 确认 `shared/data/room-ttl.json` 存在（默认 15 分钟）；
5. 重启 matchmaker / dashboard，验证：
   - `GET /mm/api/room-ttl` → `{"minutes":15}`
   - `GET /api/room-ttl` → `{"minutes":15}`
   - 建房倒计时 15:00，重启 node 后延续。

## 校验值

| 文件 | 字节 | sha256 前 16 位 |
|---|---|---|
| node-1/server/lobby.js | 111852 | `673fc1d238910e3e` |
| node-1/server/persist/lobbyState.js | 13973 | `4235bfd731ff6b44` |
| matchmaker/server.js | 23360 | `8ffce23db47c7183` |
| dashboard/server.js | 19640 | `1825c58e404f8680` |
| dashboard/public/app.js | 21939 | `f65bc75e3e86b57c` |
| dashboard/public/index.html | 9841 | `62f283d41234ee14` |
| ecosystem.config.cjs | 4004 | `d5acd23e9b27e914` |
| matchmaker/public/client.js | 89873 | `636f0469a82fefd0` |
| shared/data/room-ttl.json | 19 | `35fabbc66a463baa` |

> 说明：本补丁快照仅本地保存 + 仓库记录说明，不上传服务端源码与美术资源。
