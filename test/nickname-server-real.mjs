// 从 matchmaker/account.cjs 抽出真实的昵称校验函数并实测（避免"测试的是副本"）。
//   node test/nickname-server-real.mjs
import fs from 'node:fs';

const src = fs.readFileSync('matchmaker/account.cjs', 'utf8');
const lines = src.split('\n');
const startIdx = lines.findIndex((l) => l.includes('const NICK_W_MAX'));
if (startIdx < 0) { console.log('找不到 NICK_W_MAX'); process.exit(1); }
// 从 NICK_W_MAX 起，取到 checkNickname 函数体结束（顶层右花括号且下一行不是缩进内容）
let endIdx = -1;
let inFn = false;
let depth = 0;
for (let i = startIdx; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('function checkNickname')) inFn = true;
  for (const ch of l) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (inFn && depth === 0) { endIdx = i; break; }
}
if (endIdx < 0) { console.log('找不到 checkNickname 结束位置'); process.exit(1); }
const seg = lines.slice(startIdx, endIdx + 1).join('\n');
if (!seg.includes('checkNickname')) { console.log('抽取失败'); process.exit(1); }

const mod = await import('data:text/javascript,' + encodeURIComponent(seg + '\nexport { checkNickname, nickWidth };'));
const { checkNickname, nickWidth } = mod;

const cases = [
  ['ZcElytra', true, '8 个英文（本次报错的代号）'],
  ['一二三四五六七八', true, '8 个汉字'],
  ['abcdefgh12345678', true, '16 个英文数字'],
  ['测试博士abcdefgh', true, '4 汉字 + 8 英文 = 宽度 16'],
  ['一二三四五六七八九', false, '9 个汉字（超）'],
  ['abcdefgh123456789', false, '17 个英文（超）'],
  ['测试博士啊abcdefg', false, '5 汉字 + 7 英文 = 宽度 17（超）'],
  ['a b', false, '含空格'],
  ['abc!', false, '含感叹号'],
  ['', false, '空'],
  ['X', true, '单字符'],
];

console.log('==== 服务端真实函数 checkNickname 实测 ====\n');
let fail = 0;
for (const [s, want, desc] of cases) {
  const r = checkNickname(s);
  const got = r === null;
  const ok = got === want;
  if (!ok) fail++;
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + JSON.stringify(s).padEnd(22)
    + ' 宽度=' + String(nickWidth(s)).padEnd(3)
    + ' ' + (got ? '通过' : '拒绝(' + r.reason + ')').padEnd(14) + desc);
}
console.log(fail ? '\n' + fail + ' 项失败' : '\n全部通过');
process.exit(fail ? 1 : 0);
