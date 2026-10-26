// 有账号的玩家被误判成「游客」：name 为空导致 hello/rehandshake 全部失效。
//
// 现象：dashboard 里多个「房主」显示游客标签，实查账号库却都有账号
//（云生 id=1099、paintt1 id=774、IP黄金王座 id=642 …），房间数据里 accountId 为空。
//
// 因果链：
//   1. NAME 只从 URL ?name= 取 → 老玩家直接开域名时 NAME=''
//   2. client.js 里 `if (NAME && !entered)` → NAME 空，net.setName 从不调用
//      （即使 NAME 有值，老玩家 entered=true 也跳过）
//   3. net.name 为空 → _onOpen 的 `if (this.name)` 不成立，连 hello 都不发；
//      rehandshake() 的 `if (... || !this.name) return false` 也直接返回
//   4. accountToken 送不到服务端 → session.accountId 为空
//   5. lobby.js: `guest: session.guest === true || !session.accountId` → 判成游客
//
//   node test/guest-mislabel.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const client = fs.readFileSync('matchmaker/public/client.js', 'utf8');
const net = fs.readFileSync('node-1/public/js/net.js', 'utf8');          // 客户端
const netSrv = fs.readFileSync('node-1/server/net.js', 'utf8');          // 服务端
const observer = fs.readFileSync('node-1/public/js/ui/accountObserver.js', 'utf8');
const lobby = fs.readFileSync('node-1/server/lobby.js', 'utf8');

console.log('=== 根因链逐环核对 ===\n');

check('① 服务端：accountId 为空即判游客',
  /guest: session\.guest === true \|\| !session\.accountId,/.test(lobby));
check('① 服务端：有 accountToken 就写入 accountId', (() => {
  const i = netSrv.indexOf('const account = readUserToken(msg.accountToken);');
  if (i < 0) return false;
  const seg = netSrv.slice(i, i + 300);
  return seg.includes('if (account) {') && seg.includes('session.accountId = String(account.uid);');
})());

check('② net.name 为空时 hello 不发',
  /if \(this\.name\) \{[\s\S]{0,200}?_sendHello\(\)/.test(net) || /_onOpen\(\)[\s\S]{0,300}?if \(this\.name\)/.test(net));
check('② net.name 为空时 rehandshake 直接返回 false',
  /rehandshake\(\) \{\s*\n\s*if \(!this\.ws \|\| this\.ws\.readyState !== WS_OPEN \|\| !this\.name\) return false;/.test(net));

console.log('\n=== 修复①：NAME 不再只依赖 URL 参数 ===\n');
check('★ NAME 从 URL 取不到时回退 localStorage',
  /const fromUrl = \(q\.get\('name'\) \|\| ''\)\.trim\(\);/.test(client)
  && /for \(const k of \['sp\.name', 'mm\.name'\]\)/.test(client));
check('★ 去掉名字里的 #四位代码 后缀（账号名形如 雾灯#6923）',
  /replace\(\/#\\d\{4\}\\s\*\$\/, ''\)/.test(client));

console.log('\n=== 修复②：setName 不再被 entered 挡住 ===\n');
// 只看真代码行，忽略注释（注释里会提到旧写法作为说明）
const clientCode = client.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('★ 旧写法 `if (NAME && !store.get().session.entered)` 已从代码移除',
  !/if \(NAME && !store\.get\(\)\.session\.entered\)/.test(clientCode));
check('★ 现在只要 NAME 非空就调用 setName',
  /if \(NAME\) \{[\s\S]{0,400}?net\.setName\(NAME\)/.test(client));
check('setName 是幂等的（同名字不重复握手）',
  /if \(this\.status === 'online' && this\.helloName === n\) return;/.test(net));

console.log('\n=== 修复③：握手前兜底补名字 ===\n');
check('★ rehandshake 前若 net.name 为空则先 setName',
  /if \(!net\.name\) \{[\s\S]{0,200}?net\.setName\(nm\)/.test(observer) ||
  /if \(!net\.name\) net\.setName\(window\.__SP_ACCOUNT_USER\)/.test(observer));

console.log('\n=== 行为推演 ===\n');
const scenarios = [
  ['老玩家直接打开域名（无 ?name=，localStorage 有名字）', '有名字', 'hello 正常、accountId 写入、显示玩家'],
  ['老玩家 + localStorage 也没名字', '无名字', '仍会等账号到达后由 accountObserver 补设'],
  ['新玩家带 ?name= 进入', '有名字', '与之前一致，无回归'],
];
for (const [s, name, result] of scenarios) {
  console.log(`  ${s}`);
  console.log(`    名字来源: ${name} → ${result}`);
}

console.log('\n=== 回归保护 ===\n');
check('URL 的 ?name= 仍然优先于 localStorage',
  client.indexOf("const fromUrl = (q.get('name')") < client.indexOf("for (const k of ['sp.name', 'mm.name'])"));
check('隐私模式不抛异常（localStorage 访问有 try/catch）',
  /try \{\s*\n\s*for \(const k of \['sp\.name', 'mm\.name'\]\)/.test(client));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
