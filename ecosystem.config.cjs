// ecosystem.config.cjs — PM2 配置：node-1 … node-30，端口 3001 … 3030
// 用法（在仓库根目录下）：
//   pm2 start ecosystem.config.cjs     # 启动全部 30 个节点
//   pm2 save                           # 保存进程列表（配合开机自启用）
//   pm2 list                           # 查看状态
//   pm2 logs node-7                    # 看单个节点日志
//   pm2 restart node-7 / pm2 stop node-7 / pm2 delete node-7
// 每个节点都以自己的文件夹为工作目录，服务器按自身位置解析 public/、data/，互不干扰。
//
// 注意：不能直接 script: 'server/index.js'。该文件只在「自身是 node 的入口」时才自动
// listen（server/http/boot.js → isProcessEntry），PM2 用 ProcessContainerFork.js 包装
// 启动会破坏这个判断：进程显示 online，但永远不监听端口、日志为空。因此统一经
// pm2-run-node.cjs 显式调用 startServer()，端口由环境变量 PORT 传入。

// 部署根目录：优先环境变量 SP_ROOT，否则由本文件的所在目录推导（不写死盘符）。
// 这样换机器/换路径都不用改这个文件，仓库公开时也不会泄露部署机的目录结构。
const path = require('node:path');
const BASE = process.env.SP_ROOT || __dirname;
const NODES = 30;

const apps = Array.from({ length: NODES }, (_, i) => {
  const n = i + 1;          // node-1 … node-30
  const port = 3000 + n;    // 3001 … 3030（与 nginx 的 p1…p30 一一对应）
  return {
    name: `node-${n}`,
    cwd: `${BASE}\\node-${n}`,
    script: `${BASE}\\pm2-run-node.cjs`,
    interpreter: 'node',
    exec_mode: 'fork',
    instances: 1,
    env: {
      PORT: String(port),
      // 只监听回环：对外统一走 nginx:81，外部无法直连各节点端口
      HOST: '127.0.0.1',
      SP_NODE_DIR: `${BASE}\\node-${n}`,
      NODE_ENV: 'production',
      // 防护：同一 IP 的房间数 / AI 队友累计上限
      // 房间数曾是 1：同一网络（宿舍、网吧、家庭共用光猫）只能有一个房间，
      // 第二个人建房直接被拒「too many rooms from your network」，
      // 而玩家反复点又反复失败（日志里成串 +10 similar refusals）。
      // 玩家雾灯等人反馈的「对局结束 / 中途退出后不能创建房间」也叠了这一层。
      // 现在放宽到 3：同网络正常多人够用，仍能挡住单 IP 狂刷房间。
      SP_MAX_ROOMS_PER_ADDR: '3',
      SP_REDIS_URL: 'redis://127.0.0.1:6379/0',
      SP_REDIS_PREFIX: `sp:n${n}:`,
      // 灰度：仅 node-1 启用整图检查点与整图恢复
      // 整图检查点 + 整图恢复：全部节点启用（调试接口不开）
      SP_MAX_BOTS_PER_ADDR: '6',
      // node-4 is the isolated experimental test node; every normal node leaves experimental rooms disabled.
      // 5–20 人房现已对所有节点开放：匹配池按人数分组（4/5/6/…/20 各自成池），
      // 前端建房时可选人数，房间内房主也能用「实验性功能」调整。
      // 以前只有 node-4 打开，等于全服只有一台机器能开多人大厅，匹配里也就见不到 5 人以上的局。
      SP_EXPERIMENTAL: '1',
        // 对局跑在独立 worker 线程里：单局崩溃/卡死不影响节点主进程
      SP_MATCH_HOST: 'worker',
      // 优雅关闭宽限（2026-10-30）：官方默认 5 秒，对「几十个玩家 + 进行中的对局」太短 ——
      // 超时后进程被直接退出，玩家看到的是突然断线，而不是 room.closed{reason:'shutdown'}。
      // 20 秒给足房间序列化、socket 1001 关闭、存档 flush 的时间。
      SP_SHUTDOWN_TIMEOUT_MS: '20000',
      // AI 队友策略（2026-10-30，维护者决定：固定一种，不做随机）。
      //
      // 官方 0.3.3 的四种内置策略（docs/BOT_STRATEGIES.md）：
      //   legacy          原始 bot（139KB 的 bot.js），不设这个变量时的默认值
      //   adaptive        只换站位：legacy 试 3 种模板，它试最多 8 种，挑「一个怪都不漏」的
      //   ioleta          只换采购（且仅在罗素阵营生效）：按回合分阶段攒核心，第 7/9/11 回合逐步退出，
      //                   第 10/12 回合升级；开局会强制优先选 band_ioleta
      //   ioleta-adaptive 上面两个的合体：罗素采购 + 8 种站位搜索
      //
      // 为什么选 adaptive 而不是更强的 ioleta-adaptive（2026-10-30，改过一次）：
      //
      //   ioleta 的 pickBand 是「罗素可选就无条件选罗素」，而去重靠 phases.js 的 bandTaken()：
      //
      //     bandTaken(bandId, playerId) {
      //       if (this.allowRepeat) return false;   // ← 「允许重复选择策略」开着时恒为 false
      //       ...
      //     }
      //
      //   于是 5-20 人房勾了「允许重复选择策略」时，bandTaken 永远 false：
      //   同一队里**每一个 AI 都会选罗素**，全部走同一套采购目标
      //   （CORE = deputShip / steadShip / preciShip），互相稀释同一个卡池，
      //   谁都凑不齐三连，集体发展不起来 —— 比 legacy 的按 LP 分散更差。
      //   legacy 的 botPickBand 是按起始 LP 加权分散的，天然不会撞车。
      //
      //   adaptive 完全不碰阵营选择（沿用 legacy 的 pickBand 与采购），只优化站位：
      //   8 种候选搜索找「零漏怪」的摆法，是任何房间配置下的纯收益，没有副作用。
      //
      // 想再往前一步时可以改回 'ioleta-adaptive'，但要先解决上面那个去重问题
      //   （或在房间里不允许 AI 全选同一阵营）。
      // 直接删掉这一行则回到官方默认的 legacy。
      SP_BOT_STRATEGY: 'adaptive',
    },
    // 进程守护
    autorestart: true,
    max_restarts: 20,
    min_uptime: '20s',
    restart_delay: 3000,
    kill_timeout: 8000,
    // 内存异常时自动重启（正常一个节点约 100–200 MB）
    max_memory_restart: '1G',
    // 每个节点单独的日志
    out_file: `${BASE}\\logs\\node-${n}.out.log`,
    error_file: `${BASE}\\logs\\node-${n}.error.log`,
    merge_logs: false,
    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    watch: false,
  };
});

// 管理面板：http://<本机>:3080/ —— 查看 30 个节点状态、一键启停/重启/打开全部页面
const dashboard = {
  name: 'dashboard',
  cwd: `${BASE}\\dashboard`,
  script: 'server.js',
  interpreter: 'node',
  exec_mode: 'fork',
  instances: 1,
  env: { DASH_PORT: '3080', DASH_HOST: '127.0.0.1' },
  autorestart: true,
  max_restarts: 20,
  min_uptime: '10s',
  restart_delay: 2000,
  out_file: `${BASE}\\logs\\dashboard.out.log`,
  error_file: `${BASE}\\logs\\dashboard.error.log`,
  merge_logs: false,
  time: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  watch: false,
};

// 全局匹配服务：http://<主机>:81/mm/ 排队，凑满 4 人后把玩家钉到同一节点并进房
// 哪些节点对外开放**只由 nginx 决定**（nginx/conf/nginx.conf 的 split_clients 与
// $sp_cookie_open）。匹配器的 MM_DISABLED_NODES 只在需要时临时启用：
// 不设时匹配器会把新对局分到任何健康节点，而能进来的玩家本来就只会落在 nginx
// 放行的节点上，两者不会冲突，少一处要同步的配置。
const matchmaker = {
  name: 'matchmaker',
  cwd: `${BASE}\\matchmaker`,
  script: 'server.js',
  interpreter: 'node',
  exec_mode: 'fork',
  instances: 1,
  env: {
    MM_PORT: '3090',
    MM_HOST: '127.0.0.1',
  },
  autorestart: true,
  max_restarts: 20,
  min_uptime: '10s',
  restart_delay: 2000,
  out_file: `${BASE}\\logs\\matchmaker.out.log`,
  error_file: `${BASE}\\logs\\matchmaker.error.log`,
  merge_logs: false,
  time: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  watch: false,
};

// Nginx: 由 Windows 计划任务 SP-Nginx-Start 以 SYSTEM 身份（Session 0）启动，
// **不再**由 pm2 托管。
//
// 原设计是让 PM2 用 nginx\run-nginx.mjs 把 nginx 拉在前台，这样 PM2 能重启它。
// 但 PM2 托管时 nginx 会挂在调用者的会话下；维护者要求「不能挂在任何用户会话上」，
// 于是 2026-10-27 起改走计划任务。
//
// ⚠ 2026-10-28 事故：当时只改了启动方式，**没有停掉 pm2 里的 nginx-gateway**。
//   443 已被 SYSTEM nginx 占用 → nginx-gateway 每次启动都 bind 失败 →
//   `autorestart: true` 让它无限重试，实测崩溃循环 **4321 次**，
//   玩家体感就是「一直在重启」。删掉这个应用即可根治。
//
// 现在 nginx 的崩溃自愈由两处覆盖：
//   * 计划任务 SP-Nginx-Start        —— 开机启动
//   * deploy\_stack-watchdog.ps1      —— 每 2 分钟检查，进程没了就 schtasks /Run 拉起
// 两者都是 SYSTEM / Session 0，不依赖任何登录会话。
//
// 不要在 ecosystem 里重新加回 nginx：会和 SP-Nginx-Start 抢 443 端口。

module.exports = { apps: [...apps, dashboard, matchmaker] };
