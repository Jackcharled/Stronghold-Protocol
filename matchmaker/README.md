# 全局匹配服务（/mm/）

跨 30 个节点的公开匹配：玩家在 `http://<主机>:81/mm/` 填代号、选难度，凑满 4 人后自动分配到同一个空闲节点，
房主自动建房、其余三人自动进房，直接开始对局。

## 架构

```
浏览器 ──:81──> nginx ──/mm/──> matchmaker (127.0.0.1:3090)   排队 / 选节点 / 发房间码
                     └──/──────> node-N (127.0.0.1:300N)      游戏本体
```

- 每个玩家的 `sp_node` Cookie 决定他被 nginx 转到哪个节点（`shared` 里的那份代码由 30 个节点共用）。
- 匹配服务每秒检查一次队列；同难度满 4 人时选「当前人数最少」的节点，给 4 个人写好 `sp_node`，然后：
  - 房主 → `/?mmhost=1&mid=…&t=…&tk=…&d=…&name=…`（客户端 `public/js/mmAuto.js` 自动 `room.create` 并把房间码回报给 `/mm/api/room`）
  - 队员 → `/?room=<4 位房间码>&name=…`（走游戏自带的深链自动加入）

## 接口（都经 nginx 的 `/mm/` 暴露）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/mm/api/join` | `{name, difficulty}` → `{id, secret}` 票据 |
| GET | `/mm/api/state?id=&secret=` | 排队位置 / 已匹配信息（角色、节点、房间码） |
| POST | `/mm/api/leave` | 取消排队（已匹配不可取消） |
| POST | `/mm/api/room` | 房主回报房间码 `{matchId, ticketId, secret, code}` |
| GET | `/mm/api/pin?id=&secret=&node=` | 写入 `sp_node` Cookie，把玩家钉到指定节点 |
| GET | `/mm/api/stats` | 排队人数、对局数、各节点负载（供管理面板用） |

难度取值：`FUNNY` 标准 / `NORMAL` 险境 / `HARD` 绝境 / `ABYSS` 终极。

## 数据与限制

- 队列、票据、对局全部在内存里；**匹配服务重启会清空正在排队的人**（玩家刷新页面重排即可）。
- 票据 15 分钟过期；成局后 5 分钟内没拿到房间码会自动解散重排。
- 节点选择看 `/healthz` 的 `humans` / `rooms`，每 3 秒刷新一次；连不上的节点不会被选中。
- 没有账号体系，代号只在本次匹配里用来显示。

## 运维

- PM2 应用名 `matchmaker`，日志 `logs/matchmaker.out.log` / `.error.log`。
- 改端口：`ecosystem.config.cjs` 里 `MM_PORT`（同时要改 nginx 的 `/mm/` 反代地址）。
- 手动看队列：`http://127.0.0.1:81/mm/api/stats`。
