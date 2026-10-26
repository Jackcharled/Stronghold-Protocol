// 「恢复对局」按钮必须同时出现在**标题页**和**大厅**
//
// 玩家反馈：按钮只在联厅出现，标题页没有（截图里标题页右上角只有「在线 N 人」）。
//
// 根因：按钮要插到一个「锚点」元素旁边，而锚点链只列了大厅的：
//   公告按钮 #mm-notice-btn → 版本按钮 .verchip
// 这两个在标题页都不存在，于是每次都落到最下面的兜底分支（固定定位在右下角），
// 玩家在标题页基本看不到。
//
//   node test/resume-button-on-title.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const client = fs.readFileSync('matchmaker/public/client.js', 'utf8');
const title = fs.readFileSync('node-1/public/js/screens/title.js', 'utf8');

console.log('=== 标题页确实有 .title-corner__tools 工具条 ===\n');
check('title.js 里有 title-corner__tools', /class="title-corner__tools"/.test(title));
check('工具条里有统计/在线按钮 .title-stats', /class="title-stats"/.test(title));
check('工具条里有语言切换 .title-lang', /class="title-lang"/.test(title));

console.log('\n=== 锚点链必须覆盖标题页 ===\n');
check('★ 锚点链包含 .title-corner__tools', /querySelector\('\.title-corner__tools'\)/.test(client));
check('★ 标题页优先插在「统计/在线」按钮之前',
  /titleTools\.querySelector\('\.title-stats'\)/.test(client));
check('★ 标题页锚点排在大厅公告之前或并列（两个界面都能用）',
  /const anchor = notice\s*\n\s*\|\| titleAnchor/.test(client));
check('大厅公告按钮仍是第一优先', client.indexOf("const notice = document.getElementById('mm-notice-btn')") < client.indexOf('const titleTools'));

console.log('\n=== 按钮出现时机（两个界面一致）===\n');
check('1.5s / 4s / 8s 各试一次，之后每 6s',
  /setTimeout\(probe, 1500\)/.test(client) && /setTimeout\(probe, 4000\)/.test(client)
  && /setTimeout\(probe, 8000\)/.test(client) && /setInterval\(probe, 6000\)/.test(client));
check('账号变化时立即重查', /sp:account-changed/.test(client));

console.log('\n=== 兜底仍然存在（锚点全缺失时）===\n');
check('★ 所有锚点都找不到时退回固定定位按钮',
  /mm-resume-fallback/.test(client) && /position:fixed/.test(client));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
