import { spawn } from 'node:child_process';

const root = 'D:\\Stronghold-Protocol\\nginx';
const child = spawn('D:\\Stronghold-Protocol\\nginx\\nginx.exe', ['-p', 'D:\\Stronghold-Protocol\\nginx\\', '-g', 'daemon off;'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code) => process.exit(code == null ? 1 : code));
child.on('error', (err) => { console.error(err); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* ignore */ } });
}
