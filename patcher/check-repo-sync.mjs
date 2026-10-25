import { spawnSync } from 'node:child_process';

const run = (args) => spawnSync('git', args, { stdio: 'pipe', encoding: 'utf8' });

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
