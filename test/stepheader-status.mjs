// StepHeader 的 status 槽位：选策略界面的「请选择策略 / 跳过选择 / X 正在选择策略… / 策略选择完成」
// 全靠它显示。0.3.3 升级上游时 matchChrome.js 丢了 status 参数和渲染块，导致整个头部状态栏消失
// （页面上看不到跳过按钮，玩家以为功能没了）。这里守住它。
//   node test/stepheader-status.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const chrome = fs.readFileSync('node-1/public/js/ui/matchChrome.js', 'utf8');
const band = fs.readFileSync('node-1/public/js/screens/bandDraft.js', 'utf8');

console.log('=== StepHeader 必须支持 status 槽位 ===\n');
check('★ 函数签名接收 status', /export function StepHeader\(\{[^}]*status\s*=\s*null/.test(chrome));
check('★ 渲染 stephead__status 容器', /class="stephead__status"/.test(chrome));
check('★ 同时渲染分隔线 stephead__sep', /stephead__status[\s\S]{0,120}stephead__sep/.test(chrome));

console.log('\n=== 选策略界面把 head 传给 status ===\n');
check('★ bandDraft.js 传 status=head', /status=\$\{head\}/.test(band));
check('head 含「请选择策略」', /请选择策略/.test(band));
check('head 含跳过按钮 draft-skip', /class="draft-skip"/.test(band));
check('head 含「跳过选择」/「无法跳过」文案', /跳过选择/.test(band) && /无法跳过/.test(band));
check('head 含「正在选择策略…」', /正在选择策略/.test(band));
check('head 含「策略选择完成」', /策略选择完成/.test(band));

console.log('\n=== 跳过按钮的显示条件（4 人局可跳过）===\n');
check('未把「并发草稿」之外的房间排除掉',
  /const canSkip = !solo && !draft\.concurrent && myTurn && skipsLeft > 0/.test(band),
  '只有并发草稿（5–20 人大厅）没有跳过');
check('服务端 skipBand 同样只在并发时拒绝', (() => {
  const s = fs.readFileSync('node-1/server/match/match/phases.js', 'utf8');
  return /skipBand\(ps\)/.test(s) && /if \(d\.concurrent\) return fail\(ERR\.WRONG_PHASE/.test(s)
    && /if \(this\.draftTurn\(\) !== ps\.playerId\) return fail\(ERR\.NOT_YOUR_TURN\)/.test(s);
})());

console.log('\n=== CSS 支撑（缺了就渲染成裸文字/挤在一起）===\n');
const css = fs.readFileSync('shared/public/css/screens/briefing.css', 'utf8')
  + fs.readFileSync('shared/public/css/screens/draft.css', 'utf8');
check('.stephead__status 有规则', /\.stephead__status\s*\{/.test(css));
check('.stephead__sep 有规则', /\.stephead__sep\s*\{/.test(css));
check('.draft .stephead__status 有规则', /\.draft \.stephead__status/.test(css));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
