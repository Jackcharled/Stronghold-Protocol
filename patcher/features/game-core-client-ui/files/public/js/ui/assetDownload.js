// The title screen's 下载完整素材 (docs/history/0.3.0.md §32.14.23): the button, its hint line and the dialog, which starts the
// download queue (assetDownload.js) as it opens; closing it pauses. The import of a local pack has its own button beside
// this one (ui/assetImport.js, §32.14.39): a file already imported counts as ready here and is not requested again.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, ProgressBar } from './components.js';
import { assetDownload } from '../assetDownload.js';
import { t } from '../../../shared/i18n.js';

/** 本地时间 `YYYY-MM-DD HH:MM:SS` + 时区标注（导出的清单给服主看，必须是人能直接对上的时间）。 */
export function localStamp(now = Date.now(), tzOffsetMin = new Date(now).getTimezoneOffset()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  // getTimezoneOffset() 是「UTC - 本地」的分钟数（东八区为 -480）
  const sign = tzOffsetMin <= 0 ? '+' : '-';
  const abs = Math.abs(tzOffsetMin);
  const tz = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { local: `${y}-${mo}-${da} ${h}:${mi}:${s}`, tz, iso: d.toISOString() };
}

/** 失败清单的文本形式：一行一个「状态<TAB>URL」，可直接贴给服主或存成 .txt。 */
export function failuresToText(failures, now = Date.now()) {
  const list = Array.isArray(failures) ? failures : [];
  // 以前这里用 toISOString()（UTC），玩家看到的时间比本地慢 8 小时，以为清单是旧的。
  // 现在第一行是本地时间 + 时区，括号里附 UTC 便于跨时区对账。
  const t = localStamp(now);
  const head = [
    `# 素材下载失败清单  ${t.local}（${t.tz}，UTC ${t.iso}）`,
    `# 共 ${list.length} 条`,
    `# 状态\tURL`,
  ];
  const body = list.map((f) => `${f && f.status != null ? f.status : 'network'}\t${(f && f.url) || ''}`);
  return [...head, ...body].join('\n') + '\n';
}

/** Download the failure list as a .txt file (no server round-trip). */
export function exportFailures(failures) {
  try {
    const text = failuresToText(failures);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // 文件名也用本地时间（以前是 UTC，文件名和内容都比本地慢 8 小时）
    const stamp = localStamp(Date.now()).local.replace(/[: ]/g, '-');
    a.href = url;
    a.download = `素材下载失败清单-${stamp}.txt`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { document.body.removeChild(a); } catch { /* ignore */ } URL.revokeObjectURL(url); }, 0);
    return true;
  } catch { return false; }
}

/** Copy the failure list to the clipboard (fallback when a download is blocked). */
export async function copyFailures(failures) {
  const text = failuresToText(failures);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the textarea trick */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch { return false; }
}

/** 下载完整素材: the button, its hint line and the download dialog. */
export function AssetDownloadButton() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(() => assetDownload.get());
  useEffect(() => {
    const off = assetDownload.subscribe(setState);
    setState(assetDownload.get());
    return () => {
      off();
      assetDownload.pause();
    };
  }, []);
  const busy = ['preparing', 'verifying', 'downloading'].includes(state.phase);
  const close = () => {
    assetDownload.pause();
    setOpen(false);
  };
  const status = state.phase === 'complete' ? t('本次素材下载完成')
    : state.phase === 'preparing' ? t('正在读取素材清单…')
      : state.phase === 'verifying' ? t('正在检查已缓存的素材…')
        : state.phase === 'paused' ? t('素材下载已暂停')
          : state.phase === 'error' ? t('无法读取素材清单，请检查网络后重试。')
            : state.phase === 'partial' ? t('有 {n} 个素材下载失败', { n: state.failures.length })
              : t('正在下载素材…');
  const label = state.phase === 'complete' ? t('素材已下载')
    : state.phase === 'paused' ? t('继续下载素材') : t('下载完整素材');

  // done includes both imported files and fully read downloads; cached counts imports only.
  const ready = state.done || 0;
  const missing = Math.max(0, (state.total || 0) - ready);
  return html`<div class="title-assets__item">
    <${Button} variant="secondary" block=${true} size="sm" data-testid="asset-download" aria-describedby="title-asset-download-hint" onClick=${() => {
      setOpen(true);
      if (state.phase !== 'complete') void assetDownload.start();
    }}>${label}<//>
    <small id="title-asset-download-hint">${t('含模型、贴图和音频，建议使用 Wi-Fi 下载。')}</small>
    <${Modal} open=${open} onClose=${close} title=${t('下载完整素材')} class="asset-download" actions=${html`
      ${busy ? html`<${Button} onClick=${() => assetDownload.pause()}>${t('暂停下载')}<//>`
        : html`<${Button} variant="primary" data-testid="asset-download-resume" onClick=${() => void assetDownload.start()}>
          ${state.phase === 'complete' ? t('检查并补齐') : state.phase === 'paused' ? t('继续下载素材') : t('重试下载')}<//>`}
      <${Button} onClick=${close}>${t('关闭')}<//>`}>
      <p role="status" data-testid="asset-download-status">${status}</p>
      <${ProgressBar} value=${state.done} max=${state.total || 1} label=${t('已完成 {done} / {total} 个文件', { done: state.done, total: state.total })} />
      <p>${t('已读取 {size} MB（含浏览器缓存）', { size: (state.bytes / 1048576).toFixed(1) })}</p>
      ${state.total > 0 ? html`<p>${t('已就绪 {ready}，缺少 {missing}', { ready, missing })}</p>` : null}
      <p class="t-lo">${t('已导入的素材直接使用，不再向服务器请求。')}</p>
      <p class="t-lo">${t('下载本服务器提供的素材到浏览器缓存。关闭窗口会暂停；缓存被清理后可再次下载。')}</p>
      <p class="t-lo">${t('已下载完成的素材不会重复下载；清理浏览器缓存后再点一次即可重新下载。')}</p>
      ${state.localMissing ? html`<p class="t-lo">${t('服务器未提供额外的本地素材包，将使用基础素材。')}</p>` : null}
      ${state.failures.length ? html`<div class="asset-download__errors">
        <p>${t('下载未完成。请重试；若文件持续缺失，请联系服主补齐素材。')}</p>
        <details><summary>${t('查看失败文件')}（${state.failures.length}）</summary><ul>
          ${state.failures.slice(0, 30).map((item) => html`<li key=${item.url}><code>${item.url}</code> (${item.status})</li>`)}
          ${state.failures.length > 30
            ? html`<li class="t-lo">${t('仅显示前 30 条，共 {n} 条。点「导出清单」可拿到完整列表。', { n: state.failures.length })}</li>`
            : null}
        </ul></details>
        <div class="asset-download__export">
          <${Button} size="sm" variant="secondary" data-testid="asset-download-export"
            onClick=${() => exportFailures(state.failures)}>${t('导出清单')}<//>
          <${Button} size="sm" variant="secondary" data-testid="asset-download-copy"
            onClick=${() => copyFailures(state.failures)}>${t('复制清单')}<//>
        </div>
      </div>` : null}
    <//>
  </div>`;
}
