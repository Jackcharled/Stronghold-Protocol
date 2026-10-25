import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Windows 上 git 不一定在 PATH 里（本服机器的 Git 装在 Program Files），
// 先找 PATH，再退回常见安装位置，避免门禁脚本本身跑不起来。
const GIT_CANDIDATES = [
  'git',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
];
const GIT = GIT_CANDIDATES.find((p) => p === 'git'
  ? spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0
  : existsSync(p));

if (!GIT) {
  console.error('找不到 git 可执行文件');
  process.exit(2);
}

const run = (args) => spawnSync(GIT, args, { stdio: 'pipe', encoding: 'utf8' });

const inside = run(['rev-parse', '--is-inside-work-tree']);
if (inside.status !== 0) {
  console.error('不在 Git 仓库中');
  process.exit(2);
}

const remote = run(['remote', 'get-url', 'upstream']);
if (remote.status !== 0) {
  console.error('缺少 upstream remote。先执行：');
  console.error('git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git');
  process.exit(2);
}

const fetch = run(['fetch', 'upstream', '--quiet']);
if (fetch.status !== 0) {
  console.error('git fetch upstream 失败：' + (fetch.stderr || '').trim());
  process.exit(2);
}

const ancestor = run(['merge-base', '--is-ancestor', 'upstream/master', 'HEAD']);
if (ancestor.status !== 0) {
  const behind = run(['rev-list', '--count', 'HEAD..upstream/master']);
  console.error(`仓库落后 upstream ${String(behind.stdout || '').trim()} 个提交，禁止发布。`);
  console.error('先合并 upstream/master，再重新运行本检查。');
  process.exit(1);
}

console.log('仓库已包含最新 upstream/master');
