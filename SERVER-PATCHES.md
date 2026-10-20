# 服务端补丁 · 2026-10-20（含账号系统）

本目录是当前部署的完整补丁快照，用于后续维护、对照与重建。

## 一、账号系统（新增）

| 文件 | 作用 |
|---|---|
| matchmaker/account.cjs | QQ 邮箱验证码注册/登录、会话、图形验证码、用户偏好（user_prefs）读写 |
| matchmaker/server.js | 挂载 /api/auth/* 与 /api/prefs/*，启动时建表（accounts / user_sessions / email_codes / user_prefs） |
| matchmaker/public/account-title.js | 标题页行内登录/注册（分段按钮）、游客访问、图形验证码、首次设置代号、账号数据云同步 |
| nginx/conf/nginx.conf | /mm/ 代理、脚本注入、Cache-Control: no-store、/?reset=1 清缓存 |

**账号要点**
- 注册：QQ 邮箱 + 邮件验证码（10 分钟有效，60 秒重发，30 分钟最多 5 次）+ 密码（≥8 位）+ 图形验证码；
- 昵称：注册时不填，注册后首次输入（1~7 字），系统分配固定四位代码（如 5440）；
- 显示：标题页 `昵称#代码`；游戏内名字只有昵称；`DOCTOR #` 显示四位代码；
- 会话：HttpOnly Cookie + Bearer 令牌兜底（localStorage mm.sid）；
- 游客：可游玩、可加入，不能创建同盟/添加 AI；提示语由服务端 detail 给出。

**账号数据同步（9 个域）**
`loadout / ownership / diy / skins / cosmetics / notices / stats / annSeen / identity`
登录拉取 → 首次登录本机合并 → 修改 800ms 防抖上传 → 409 以服务端为准 → 退出清除本地账号数据。

## 二、维护开关

| 文件 | 作用 |
|---|---|
| shared/data/create-room.json | `{ "enabled": true }`，是否允许创建同盟房间 |
| dashboard/server.js | GET/POST /api/create-room |
| dashboard/public/app.js / index.html | 后台「创建同盟房间」开关（5 秒内生效，独立模拟不受影响） |

## 三、房间与计时（此前补丁，仍有效）

| 文件 | 作用 |
|---|---|
| node-*/server/lobby.js | roomTtlMs 读配置、建房冻结 room.ttlMs、join 不重置、游客/维护拦截、seats[].tag |
| node-*/server/persist/lobbyState.js | 存档 createdAt / lastMatchEndedAt / ttlMs |
| shared/data/room-ttl.json | 默认解散时长（分钟） |
| ecosystem.config.cjs | BASE、每节点 SP_REDIS_PREFIX |

## 四、DOCTOR 四位代码链路（直接改项目代码）

| 文件 | 改动 |
|---|---|
| node-*/shared/protocol.js | hello 允许 tag（4 位） |
| node-*/server/net.js | session.tag、welcome.tag |
| node-*/server/lobby.js | room.state.seats[].tag |
| node-*/public/js/net.js | hello 携带 mm.tag，缺失时自动拉 /mm/api/auth/me |
| node-*/public/js/main.js | me.tag |
| node-*/public/js/store.js | me.tag 初始值 |
| node-*/public/js/screens/lobby.js | DOCTOR # 优先 me.tag |
| node-*/public/js/screens/room.js | DOCTOR # 优先 seat.tag |
| node-*/public/js/ui/components.js | doctorNo 游客兜底 |

## 五、界面修正

- node-*/public/js/screens/title.js：标题词条恢复 `t('卫戍协议')`（修英文误替换与英文副标题消失）；
- node-*/public/js/ui/lang.js：document.title 恢复「卫戍协议：盟约」；
- matchmaker/public/client.js：标题页节点状态改为「在线 N 人」；大厅公告按钮克隆 S.W.E.E.P. 样式与间距。

## 应用顺序（重建机器时）

1. 覆盖 matchmaker/（account.cjs、server.js、public/*）；
2. 覆盖 dashboard/（server.js、public/*）；
3. 覆盖 30 个节点的 shared/protocol.js、server/net.js、server/lobby.js、server/persist/lobbyState.js；
4. 覆盖 30 个节点的 public/js（net.js、main.js、store.js、screens/*、ui/components.js、ui/lang.js）；
5. 覆盖 nginx.conf 后 `nginx -t && nginx -s reload`；
6. 确认 shared/data/room-ttl.json、create-room.json 存在；
7. `pm2 delete all && pm2 start ecosystem.config.cjs`，再重启 dashboard/matchmaker；
8. 验收：/mm/api/auth/captcha、/api/create-room、建房倒计时、DOCTOR # 显示账号代码、登录后换设备数据一致。

## 校验值

| 文件 | 字节 | sha256 前 16 位 |
|---|---|---|
| matchmaker/account.cjs | 22785 | `ac7f05cc22b225cb` |
| matchmaker/server.js | 24246 | `456f3595c7e836e1` |
| matchmaker/public/account-title.js | 29011 | `e246ab7c0151cb26` |
| matchmaker/public/client.js | 91378 | `c30775f5560d5f67` |
| nginx/conf/nginx.conf | 3135 | `2fdaeb1c4b8e606a` |
| dashboard/server.js | 20610 | `2ee07e0eef05780b` |
| dashboard/public/app.js | 23058 | `f3b619c9a7d7a1ca` |
| dashboard/public/index.html | 10388 | `1dc5bbcb11a7095a` |
| ecosystem.config.cjs | 4004 | `d5acd23e9b27e914` |
| shared/data/room-ttl.json | 19 | `35fabbc66a463baa` |
| shared/data/create-room.json | 21 | `6ba25b17d218c13a` |
| node-1/shared/protocol.js | 47071 | `bebae9ddfc955406` |
| node-1/server/net.js | 36618 | `09fe11aee720766a` |
| node-1/server/lobby.js | 112693 | `c8f1c0ded47a71dd` |
| node-1/server/persist/lobbyState.js | 13973 | `4235bfd731ff6b44` |
| node-1/public/js/net.js | 41420 | `f4c71955632d0dee` |
| node-1/public/js/main.js | 24850 | `1f2217c639a914d9` |
| node-1/public/js/store.js | 9095 | `40f1a13e22b32ac8` |
| node-1/public/js/screens/title.js | 15069 | `e5cd852f438e0bf3` |
| node-1/public/js/screens/lobby.js | 23796 | `130d87244bd638bc` |
| node-1/public/js/screens/room.js | 27148 | `dfdbc569417dce00` |
| node-1/public/js/ui/components.js | 48838 | `3e184a73210f6c8c` |
| node-1/public/js/ui/lang.js | 17448 | `840b1fe1c2ee1099` |

> 本快照仅本地保存；仓库只保留说明与客户端注入脚本，不含服务端源码与美术资源。
