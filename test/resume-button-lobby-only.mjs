// 「恢复对局」按钮**只在联厅显示，标题界面不显示**（维护者 2026-10-26 明确要求）
//
// 曾经为了让标题页也有入口，给锚点链加了 .title-corner__tools 并在标题页也建按钮，
// 这是**误读需求**造成的：维护者当时说的是「按钮只出现在大厅，标题页没有」这个现状，
// 不是要求补上。现已撤销，并把「标题页不显示」写成显式规则 + 回归测试。
//
//   node test/resume-button-lobby-only.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const client = fs.readFileSync('matchmaker/public/client.js', 'utf8');

console.log('=== 标题界面必须不显示 ===\n');
check('★ 有「停在标题屏就不建按钮」的显式规则',
  /if \(document\.querySelector\('\.title-screen'\)\) \{ removeBtn\(\); return; \}/.test(client));
check('★ 判定用页面类型（.title-screen），而不是「有没有公告按钮」',
  /document\.querySelector\('\.title-screen'\)/.test(client));
check('★ 旧的标题页锚点已移除（不能再用 .title-corner__tools / titleAnchor）',
  !/titleAnchor/.test(client) && !/titleTools\.querySelector\('\.title-stats'\)/.test(client));

console.log('\n=== 联厅里仍然正常显示 ===\n');
check('大厅公告按钮仍是第一锚点',
  /const notice = document\.getElementById\('mm-notice-btn'\)/.test(client));
check('版本按钮 / SWEEP 仍作为大厅的备选锚点',
  /verchip-wrap, button\.verchip/.test(client) && /S\\\.W\\\.E\\\.E\\\.P/.test(client));
check('锚点全缺失时的固定定位兜底仍在（大厅版式变化时用得上）',
  /mm-resume-fallback/.test(client));

console.log('\n=== 代码顺序：标题屏判断必须在建按钮之前 ===\n');
check('★ 标题屏 return 出现在 cloneNode 之前',
  (() => {
    const guard = client.indexOf("if (document.querySelector('.title-screen'))");
    const clone = client.indexOf('const btn = (notice || anchor).cloneNode(true);');
    return guard > 0 && clone > 0 && guard < clone;
  })());
check('★ 也出现在兜底建按钮之前',
  (() => {
    const guard = client.indexOf("if (document.querySelector('.title-screen'))");
    const fb = client.indexOf("fb.className = 'verchip mm-resume-fallback'");
    return guard > 0 && fb > 0 && guard < fb;
  })());

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
