// 验证「画面质量」在手机上真的生效：高画质必须真的提高渲染分辨率（DPR）。
// 问题：render/app.js 里 dpr()/boardDpr() 对触屏设备无条件夹到 1 / 0.85，
// 于是手机上调到「高」也还是 1x —— 手机 DPR 通常 3，等于只画了 1/9 的像素，看着就是糊的。
//   node test\quality-mobile-dpr.mjs
const ROOT = process.cwd();
const fs = await import('node:fs');
const path = await import('node:path');

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const appSrc = fs.readFileSync(path.join(ROOT, 'node-1/public/js/render/app.js'), 'utf8');
const hostSrc = fs.readFileSync(path.join(ROOT, 'node-1/public/js/render/app/host.js'), 'utf8');

// 从源码里取出实际的 QUALITY_RES / BOARD_RES 表
const pick = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = \\{([^}]*)\\}`));
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(',')) {
    const kv = part.match(/(\w+)\s*:\s*([\d.]+)/);
    if (kv) out[kv[1]] = Number(kv[2]);
  }
  return out;
};
const QUALITY_RES = pick(hostSrc, 'QUALITY_RES');
const BOARD_RES = pick(hostSrc, 'BOARD_RES');
check('取到 QUALITY_RES 表', !!QUALITY_RES, JSON.stringify(QUALITY_RES));

// 复刻 app.js 里的 dpr() 逻辑：触屏（lean=true）按画质分档设上限
const TOUCH_DPR_CAP = pick(appSrc, 'TOUCH_DPR_CAP');
const TOUCH_BOARD_DPR_CAP = pick(appSrc, 'TOUCH_BOARD_DPR_CAP');
check('触屏像素上限按画质分档（不是一刀切 1）', !!TOUCH_DPR_CAP && TOUCH_DPR_CAP.high > TOUCH_DPR_CAP.low,
  JSON.stringify(TOUCH_DPR_CAP));

const dprFor = (quality, devicePixelRatio, lean) =>
  Math.min(devicePixelRatio, QUALITY_RES[quality] || 2, lean ? (TOUCH_DPR_CAP[quality] || 1) : 2);
const boardDprFor = (quality, devicePixelRatio, lean) =>
  Math.min(devicePixelRatio, BOARD_RES[quality] || 2, lean ? (TOUCH_BOARD_DPR_CAP[quality] || 0.85) : 2);

console.log('\n=== 手机（DPR 3、触屏）各画质下的实际渲染倍率 ===');
for (const q of ['low', 'medium', 'high']) {
  console.log(`  ${q.padEnd(6)} dpr=${dprFor(q, 3, true)}  boardDpr=${boardDprFor(q, 3, true)}`);
}
console.log('\n=== 桌面（DPR 2、非触屏）各画质下的实际渲染倍率 ===');
for (const q of ['low', 'medium', 'high']) {
  console.log(`  ${q.padEnd(6)} dpr=${dprFor(q, 2, false)}  boardDpr=${boardDprFor(q, 2, false)}`);
}

console.log('');
// ★ 核心断言：手机上高画质必须比低画质渲染更多像素
check('★ 手机上调到「高」比「低」更清晰',
  dprFor('high', 3, true) > dprFor('low', 3, true),
  `高=${dprFor('high', 3, true)} 低=${dprFor('low', 3, true)}`);
check('★ 手机上调到「高」比「中」更清晰',
  dprFor('high', 3, true) >= dprFor('medium', 3, true),
  `高=${dprFor('high', 3, true)} 中=${dprFor('medium', 3, true)}`);
check('★ 手机高画质要真正用上设备像素（DPR>1）',
  dprFor('high', 3, true) > 1,
  `实际=${dprFor('high', 3, true)}，设备 DPR=3`);

// 手机板面同理
check('★ 手机板面高画质也要比低画质清晰',
  boardDprFor('high', 3, true) > boardDprFor('low', 3, true),
  `高=${boardDprFor('high', 3, true)} 低=${boardDprFor('low', 3, true)}`);

// 桌面不能被改坏
check('桌面高画质保持 2x', dprFor('high', 2, false) === 2, `实际=${dprFor('high', 2, false)}`);
check('桌面低画质保持 1x', dprFor('low', 2, false) === 1, `实际=${dprFor('low', 2, false)}`);
check('桌面高 > 中 > 低', dprFor('high', 2, false) > dprFor('medium', 2, false) && dprFor('medium', 2, false) > dprFor('low', 2, false),
  `${dprFor('high', 2, false)} / ${dprFor('medium', 2, false)} / ${dprFor('low', 2, false)}`);

// 低配手机仍要能省电：低画质在手机上不能被抬太高
check('低画质在手机上仍然省电（≤1.5x）', dprFor('low', 3, true) <= 1.5, `实际=${dprFor('low', 3, true)}`);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
