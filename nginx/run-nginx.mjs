import { spawn } from 'node:child_process';
import path from 'node:path';

// 路径由脚本位置推导（本文件就在 nginx/ 下），不写死盘符。
// 需要时可用环境变量 SP_NGINX_ROOT 覆盖。
const root = process.env.SP_NGINX_ROOT || import.meta.dirname;
const exe = path.join(root, 'nginx.exe');
const child = spawn(exe, ['-p', root + path.sep, '-g', 'daemon off;'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code) => process.exit(code == null ? 1 : code));
child.on('error', (err) => { console.error(err); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* ignore */ } });
}
