// 验证「模型 404 被浏览器缓存 30 天」的自愈修复：
// 重试时必须给 skel/atlas/texture 加 cache-buster，绕开那份 immutable 的 404 缓存。
//   node test\spine-cache-bust.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const src = fs.readFileSync('node-1/public/js/assets.js', 'utf8');

// 从源码里把 spineBust 抽出来单独跑（它只依赖 isObj）
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const m = src.match(/const spineBust = \(entry, n\) => \{[\s\S]*?\n  \};/);
check('源码里能抽到 spineBust', !!m);
if (!m) { console.log('\n1 项失败'); process.exit(1); }
const spineBust = new Function('isObj', `return ${m[0].replace(/^const spineBust = /, '').replace(/;$/, '')}`)(isObj);

const ENTRY = {
  skel: 'https://cdn/assets/spine/op/char_133_mm/front/char_133_mm.skel',
  atlas: 'https://cdn/assets/spine/op/char_133_mm/front/char_133_mm.atlas',
  textures: ['https://cdn/assets/spine/op/char_133_mm/front/char_133_mm.png'],
  pma: false,
};

const b1 = spineBust(ENTRY, 1);
console.log('\n原 entry：', ENTRY.skel);
console.log('bust 后  ：', b1 && b1.skel);

check('★ 重试时 skel 带上 cache-buster', !!b1 && /\?r=1$/.test(b1.skel), b1?.skel);
check('★ atlas 也带（否则会加载到旧的 404 atlas）', !!b1 && /\?r=1$/.test(b1.atlas), b1?.atlas);
check('★ 贴图也带', !!b1 && b1.textures.every((u) => /\?r=1$/.test(u)), JSON.stringify(b1?.textures));
check('★ 不同次重试用不同的值（每次都是新缓存键）',
  spineBust(ENTRY, 1).skel !== spineBust(ENTRY, 2).skel,
  `${spineBust(ENTRY, 1).skel.slice(-6)} vs ${spineBust(ENTRY, 2).skel.slice(-6)}`);
check('★ 不修改原 entry（首次加载仍用干净 URL）',
  ENTRY.skel === 'https://cdn/assets/spine/op/char_133_mm/front/char_133_mm.skel');
check('其它字段原样保留', b1 && b1.pma === false);

// 边界：没有 atlas/textures 的 entry
const bare = { skel: ENTRY.skel };
const bb = spineBust(bare, 3);
check('只有 skel 的 entry 也能 bust', !!bb && /\?r=3$/.test(bb.skel), bb?.skel);

// 边界：相对路径不 bust（无法安全改写），应返回 null 让调用方回退到原 entry
const rel = { skel: '/assets/x.skel', atlas: '/assets/x.atlas', textures: ['/assets/x.png'] };
check('相对路径不强行改写（返回 null）', spineBust(rel, 1) === null);

// ★ 关键：首次加载不能带 bust（要能命中 CDN 正常缓存）
check('★ 首次加载用干净 URL（不加 r=）',
  /if \(!\(o && o\.fresh\)\) return \(opts\.loadSpine \|\| loadSpineData\)\(entry\);/.test(src));
check('★ 重试路径调用 spineBust', /spineBust\(entry, \+\+spineBustSeq\)/.test(src));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
