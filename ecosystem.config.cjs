// ecosystem.config.cjs — PM2 配置：node-1 … node-30，端口 3001 … 3030
// 用法（在 D:\Stronghold-Protocol 下）：
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

const BASE = 'D:\\Stronghold-Protocol';
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
// MM_DISABLED_NODES：这些节点上还有未结束的对局，暂不接收经由匹配进来的新玩家（不能重启）。
// 只在匹配器「挑哪个节点」这一步生效：已在房间里的人照常打完、继续开局、被邀请进房都不受影响。
// 等在打的局自然结束后，从列表里移除并重启匹配器即可恢复正常调度。
// 详见 PENDING-RESTART.md。
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
    MM_DISABLED_NODES: '1,3,9,10,11,12,13,14,16,17,18,19,20,23,25,27,28,29',
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

// Nginx gateway: PM2 keeps the public HTTPS/WS entry alive. The Node wrapper runs
// nginx in the foreground so PM2 can restart it instead of losing the whole site.
const nginxGateway = {
  name: 'nginx-gateway',
  cwd: `${BASE}\\nginx`,
  script: `${BASE}\\nginx\\run-nginx.mjs`,
  interpreter: 'node',
  exec_mode: 'fork',
  instances: 1,
  env: { NODE_ENV: 'production' },
  autorestart: true,
  max_restarts: 20,
  min_uptime: '10s',
  restart_delay: 2000,
  out_file: `${BASE}\\logs\\nginx-gateway.out.log`,
  error_file: `${BASE}\\logs\\nginx-gateway.error.log`,
  merge_logs: false,
  time: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  watch: false,
};

module.exports = { apps: [...apps, dashboard, matchmaker, nginxGateway] };
