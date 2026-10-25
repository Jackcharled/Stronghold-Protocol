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

### 移植上游后必须逐个手点的入口

上游改版会顺手改掉我们插入的按钮（选择器变了、容器变了、判定变了）。
移植后必须逐个确认，不要只看“页面能开”：

```text
标题屏左下角「官方Q群」   id=mm-qq，在 .title-foot 内 .mm-qq-row 独占一行，
                          排在「添加到桌面」上面（不能挤掉它的位置）
标题屏右上角「统计/语言」旁边的 公告、管理后台、账号对局按钮
大厅顶栏「官方Q群」       id=mm-qq-lobby
同盟房间顶栏「官方Q群」   id=mm-qq-room
```

踩过的坑（2026-10 升级 0.3.3）：

```text
1. client.js 里判手机用 (maxTouchPoints > 0)，触屏笔记本/桌面 Edge 报告 10，
   结果把标题屏按钮当成手机端删掉了。→ 只按 max-width 和无 hover 判断。
2. 0.3.3 的 .title-foot 是 display:flex; justify-content:space-between，
   在 flex 容器里 flex-basis:100% 不会换行，必须插入 <span class="mm-qq-row">
   占满整行，按钮才不会顶到中间或挤掉「添加到桌面」。
3. 改完 matchmaker/public/client.js 必须同步：
   - patcher/features/client-announcement/files/{matchmaker/public,mm}/client.js
   - nginx.conf 里的 /mm/client.js?v= 版本号并 nginx -s reload
4. 顶栏节点状态在「同盟模拟 / 独立模拟」弹窗里看不到、或在弹窗和大厅之间闪。
   原因：installQQGroup() 里的大厅分支每 1.5s 把 #mm-nodes 无条件搬回
   .lobby-screen .topbar__left，而 place() 又把它搬进弹窗的 .mm-proto-meter，
   两者互相抢占。→ 大厅分支必须先判断当前是否在房间/弹窗界面，
   弹窗打开时不归位，归属统一交给 place() 决定。
   两个弹窗都各测一遍，不能只测同盟模拟。
5. 节点状态图标的位置：房间（同盟/独立模拟）顶栏 → .rs-clock__ping 内，
   紧跟「当前延迟」的 PingPill 之后，做成同款圆角药丸。
   不要塞进 .proto-top（那是协议选择弹窗，另一屏）。
6. 「实验性选项」面板：必须是居中模态（复用 .modal / .modal__box +
   .exp-modal__box / .exp-modal__body），不要用从按钮飘出的绝对定位浮层
   （.exp-pop.rs-opts 加 left:0/transform:none）——那种写法在不同分辨率下
   会贴边、被裁切，还会和「同盟设置」面板叠在一起。
   开关按钮 .ailast__opt 保持自身宽度，不要加 width:100%：选中态底色
   会连成一条横贯弹窗的绿色色带。
   弹窗宽度 min(9.2rem, 94vw)；内容区 overflow:visible，不要 auto
   （宽度够时一屏放得下，出现滚动条会让人误以为还有内容没显示）。
   人数下拉在弹窗内改成「就地展开」（position:static，9 列 x 2 行），
   展开时下方选项整体下移：绝对定位无论向上还是向下都会遮挡
   （向上盖住标题、向下盖住「队友复活」）。
7. 桌面反复闪「管理员: C:\WINDOWS\System32\...」黑框。
   原因：计划任务直接跑 powershell.exe 但没加隐藏参数。服务器上每 2 分钟
   执行一次的 SP-Stack-Watchdog 最容易暴露这个问题，脚本内部再怎么用
   CreateNoWindow，任务自己拉起的那层窗口照样会闪。
   → 所有定时任务的 Action 都必须带：
     -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden
   涉及任务：SP-Stack-Watchdog、SP-DB-Backup、SP-Nginx-Start、
   SP-PM2-Resurrect、Stronghold-Server-Watchdog、SP-LetsEncrypt-Renew。
   注意 PM2 的 pidusage 另有独立的黑框问题（见下文），两者要分别修。
8. 观战席上限、表情弹幕、隐身观战 —— 这三处上游都没有，移植时容易整个丢掉。
   判断办法：改完先 grep「这些符号还有没有人用」，本项目的三次事故都是
   「组件/CSS 都在，但没人挂载/没人调用」，页面看起来正常，功能其实不存在。

   8.1 普通观战席上限必须随人数动态变化
       服务端：room.spectatorLimit() = max(MAX_SPECTATORS, ceil(activeHumans/2))
               下发在 room.state.maxSpectators。
       客户端：node-1/public/js/screens/room.js 的 SpectatorBar，
               分母必须写 ${facts.maxSpectators}。
       事故：原作者常量是 2，我们照着写死了 /${MAX_SPECTATORS}，
       于是 20 人房观战上限算出来是 10，界面却显示 /2。
       检查：node test\spectator-limit-dynamic.mjs

   8.2 表情在 5–20 人房走「弹幕」
       判定在 ui/teamLayout.js：teamDensity（>4 人或手机 → 'list'）
       → teamEmoteMode（list 或花名册折起 → 'danmaku'）。
       渲染：screens/game.js 在 .gm__hud 内挂 <Danmaku>，样式在
       css/screens/game.css 的 .gm__hud > .danmaku。
       TeamPanel 用 rowBubbles（弹幕模式为 null）代替 bubbles，
       否则同一句表情会显示两次。
       事故：Danmaku 组件和 CSS 早就写好了，但 game.js 从没 import/渲染它，
       teamEmoteMode 也没人调用 —— 5–20 人房实际一直只在行内挂气泡。
       检查：node test\emote-danmaku-5to20.mjs

   8.3 隐身观战（管理员 adminWatch）必须收到对局帧
       这个坑有两层，第二层才是真病根，只修第一层会被「看起来好了」骗过去：

       (a) 广播路径：Lobby.memberSessions() 以前只遍历 seats + spectators，
           hiddenSpectators 拿不到 m.public 的广播。
           → 要遍历 seats + spectators + hiddenSpectators 并用 seen 去重。
           → startMatch 的 opts 也要把 hiddenSpectators 传给对局。

       (b) 单播路径（真正的病根）：Lobby.sendToPlayer() 只认
           seatOf() / spectatorOf()，而隐身观战者只存在于 hiddenSpectators，
           两者都查不到，于是 addSpectator → _resync 的补发帧被直接
           return false 丢掉，前端永远停在「正在进入模拟…」。
           → sendToPlayer 的判定必须加上 room.hiddenSpectatorOf(playerId)。

       为什么容易漏：单测用假的 Match 对象直接调 broadcastRoom，绕过了
       sendToPlayer，于是只修 (a) 也能「全绿」。必须用真实进程验证：
       建房 → 加 AI → room.start → g.infoReady（离开 INFO_CHECK，
       否则对局不推进、不会再有 m.public）→ 隐身 spectate →
       先收后发帧，再让房主 g.bandSkip 产生一次新广播。

       检查：node test\hidden-watch-broadcast.mjs        （单测，覆盖 a）
             node test\e2e-hidden-watch-live.mjs 3001   （真实进程，覆盖 a+b）
       注意 e2e 脚本每次要用不同的 uid，并在退出前 room.leave，
       否则留着僵尸房间，下次跑会撞「该账号已在其他房间中」。

   三者都是 node-N/public/ 或 node-N/server/ 下的文件：
   客户端文件（public/js）nginx 直接发，改完只需改 nginx.conf 里
   /mm/client.js?v= 的版本号并 nginx -s reload；
   服务端文件（server/*.js）必须 30 个节点一起重启才生效。
```

验证方式（不要只看 DOM 存在，要量坐标）：

```powershell
node node-1\shot-qq3.mjs   # above:true 表示 Q群按钮在「添加到桌面」上方
```

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

### 上游没有区分、但本服必须改的四处（2026-10-26）

这四处都是「上游本身就这样设计」，但在本服 5–20 人房 / 手机横屏下会坏掉。
**它们不是本服新增功能，所以不会进功能快照**——上游更新后要手动确认它们还在：

1. **`server/lobby.js` 的 `startMatch()` 必须把 `room.experimental` 传进 `opts`**

   `Match.js` 用 `roomCapacity(mode, opts.experimental)` 算 `playerCapacity`，再用
   `if (opts.seats.length > this.playerCapacity) throw new RangeError('Match: seats exceed room capacity')`
   校验。上游这一行漏传 `experimental`，match 一律按默认 4 人算，
   于是**只要有第 5 个座位，「开始模拟」就回「服务器内部错误」**（玩家截图里的「服务器内部错误 ×14」）。

   确认方法：
   ```powershell
   Select-String -Path node-1\server\lobby.js -Pattern "experimental: \{ \.\.\.room\.experimental \}"
   ```
   回归测试：`node test/e2e-capacity-start.mjs 3001`（5 / 8 / 20 人都要 ✅ 已开始）。

2. **`public/css/screens/room.css` 竖屏卡片高度**

   上游 `@media (max-aspect-ratio: 1/1) { .rseat { --w: max(1.8rem, 42vw); } }` 让卡片变得很宽，
   而卡片高度仍被 `align-items: stretch` 拉满整屏 → 每张卡成了「又宽又长的竖条」。
   本服在同一个媒体查询里给 `.rseat.has-art .rseat__art` 加了 `flex: none; aspect-ratio: 3/4`。

   注意：`node-1/test/ui/seat-art.test.js` 会**逐字**校验 `--w` / `--av` 那几行，
   所以**不要改上游那几行**，只在后面追加规则（并且不能用 `:has()` / `!important`，测试会拦）。

   回归测试：`node test/check-room-mobile.mjs after`（4 人和 20 人房都要 ✅）。

3. **实验性弹窗的 `.rs-opts` 包含块问题**

   `.exp-modal` 是 `position: fixed` 的整屏遮罩，但挂在 `.rs-opts` 里面，而 `.rs-opts` 有
   `transform: translateX(-50%)` —— 带 transform 的元素会成为 fixed 后代的包含块，
   于是弹窗相对那个 149×137 的小面板定位，被推到屏幕下半截，**「应用」按钮整个掉到视口外点不到**。

   修法：`room.js` 的 `ExperimentalControl` 打开弹窗时给 `.rs-opts` 加 `.has-exp-modal`，
   CSS 里 `.rs-opts.has-exp-modal { transform: none; }` 去掉包含块；关闭时移除。

   回归测试：`node test/exp-modal-fit.mjs fixed`（9 个视口都要 ✅ 可点击）。

4. **`matchmaker/public/client.js` 的 `installModeHint()`（大厅卡片提示语颜色）**

   这条提示语是**本服**注入的（`matchmaker/public/client.js`，由 nginx 直出 `/mm/client.js`，
   **不在 30 个 node 目录里**，改完只需 bump `?v=` 并 reload nginx，不用重启节点）。

   它曾经的颜色逻辑只读 `backgroundColor`，但「同盟模拟」卡片的薄荷色在 `background-image`
   的渐变里、`backgroundColor` 是透明的，于是一路向上找到深色的 `.lobby-screen`，误判成深色卡片，
   把字刷成薄荷绿 `#4ed8af` —— 压在薄荷底上几乎看不见（玩家反馈「颜色比较淡」）。

   现在直接沿用卡片自己的 `color`（上游 `.hub-entry--coop` 已定为深墨绿 `#04140f`），
   并额外注入一条 `.hub-entry--coop .mm-mode-hint{color:#04140f!important}` 兜底。
   对比度 10.58:1（WCAG AA 要求 ≥ 4.5）。

   回归测试：`node test/hint-contrast.mjs`（每个视口都要 ✅ 清晰）。

5. **换网络 / 换设备不自动回对局（`public/js/ui/accountObserver.js`）**

   `maybeAutoResumeOnReload()` 原来有一句 `if (... || !reloadNav || ...) return;`，
   **只在浏览器刷新（reload）时才自动恢复对局**。换 WiFi / 换设备打开页面属于普通导航，
   于是永远不进恢复流程 —— 玩家表现为「切了网络没有回到对局」。

   现在改成只跳过 `back_forward`（前进/后退），普通导航和刷新都会探测；
   防循环靠三道闸：60 秒只跳一次 + `sp.matchExitAt` 2 分钟冷却 +
   新增的 `sp.matchExitAtShared`（写进 localStorage，跨标签页/跨设备也生效，
   写入端在 `public/js/ui/matchChrome.js`）。

6. **「恢复对局」按钮（本服新增，`matchmaker/public/client.js` 的 `installResumeButton()`）**

   上游/本服原本都**没有**这个按钮，玩家只能靠自动恢复。现在：
   - 只有账号确实有进行中的对局（`/mm/api/account/room` 返回了 code）时才显示；
   - 位置：**「公告」按钮左边**（与「管理后台」同一侧，管理后台更靠左）；
   - 点击 = 带 `accountResume=1` 跳到 `/r/CODE`，由 accountObserver 接管座位；
   - 在房间里、正在自动恢复、刚主动退出对局的 2 分钟内都不显示。

   这个文件由 nginx 直出，**改完只需 bump `?v=` 并 reload nginx，不用重启节点**。

7. **素材 404：nginx 缓存了 404（`nginx/conf/nginx.conf` 的 `/assets-cdn/`）**

   `proxy_cache_valid` 原来只写了 `200 206 30d`，**没管 404** → nginx 把 404 也缓存了。
   素材是陆续上传到上游 CDN 的：某个文件在上传前被请求过一次，404 就被缓存住，
   之后上游补上了，玩家仍然拿到 404 —— 表现为「下载完整素材」里一串失败文件，
   **本地 404 但上游实际 200**。

   2026-10-26 实测：缓存里 52,771 条有 64 条是 404，其中 **59 条上游其实存在**（含玩家截图里的
   `char_449_glider`），已逐条清除；剩 5 条是上游确实没有的孤儿文件，且**都没被清单引用**，不影响玩家。

   现在加了 `proxy_cache_valid 404 1m;`：404 最多挡 1 分钟，上游补齐后自动恢复。

   排查/复检命令：
   ```powershell
   node test/full-asset-sweep.mjs     # 全量扫 19k+ 素材，0 失败才算好
   node test/audit-asset-404.mjs      # 抽样快查（约 20 秒级别更快）
   ```
   注意：`full-asset-sweep` 并发 24 时偶发 **504（上游超时）**，那不代表文件缺失；
   串行重试即 200。真要清缓存，**只删上游确实没有的那些**，别整个删光。

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


