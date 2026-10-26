// Site policy (DESIGN §32.11). Hash only import maps, never arbitrary inline script. Worker/UI policies are independent.
// worker-src 'self' is the asset service worker at /sw.js. blob: stays for workers the page already creates
// (the simulation worker). Do not add a remote worker origin. SIM_WORKER_CSP is that worker's own policy and
// must not gain the asset worker. media-src blob: is the player's own lobby video and the length check of the own lobby
// music (ui/lobbyMedia.js: files of this browser read through an object URL); no remote media origin.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// SES evaluates confined code. This relaxation belongs only to the simulation Worker, never its parent document.
export const SIM_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'";

export function siteCsp(publicDir) {
  const hashes = new Set();
  for (const rel of ['index.html', 'studio/index.html', 'studio/console.html', 'dev/game-mock.html', 'dev/render-demo.html', 'dev/battle-perf.html', 'dev/uikit.html']) {
    let html;
    try { html = fs.readFileSync(path.join(publicDir, rel), 'utf8'); } catch { continue; }
    for (const m of html.matchAll(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/g)) {
      hashes.add(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    }
  }
  // 本服：美术与音频托管在资源站 assets.luobomiao.love。页面里已经把它们改写到
  // /assets-cdn/ 代理（同源），但为稳妥起见仍然显式放行该源：
  // 任何漏改写的 media/connect 请求都不会被 CSP 静默拦掉（表现为"完全没有声音"）。
  // 注意：这里只放行这一个固定域名，不是通配符，安全性不变。
  const ASSET_ORIGIN = 'https://assets.luobomiao.love';
  return `default-src 'self'; script-src 'self'${hashes.size ? ' ' + [...hashes].join(' ') : ''}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: ${ASSET_ORIGIN}; media-src 'self' blob: ${ASSET_ORIGIN}; connect-src 'self' ${ASSET_ORIGIN}; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'`;
}
