// 本服功能：皮肤设置的导入 / 导出（独立模块，避免改动上游 loadout.js 的大量逻辑）。
//
// 为什么单独成文件：上游 0.3.3 重写了 干员调配 的导入导出（`io.kind` 只认 loadout / diy / ownership），
// 我们原有的「导入皮肤 / 导出皮肤」在移植时丢失。为了以后能继续无冲突地同步 upstream：
//   * 逻辑全部放在这个文件里；
//   * 上游 public/js/screens/loadout.js 只加一个 import 和「更多」菜单里的两行按钮。
//
// 数据格式（与旧版一致，方便玩家继续用以前导出的文件）：
//   { type: 'sp-skins', version: 1, skins: { [charId]: skinId } }
// 存储位置是浏览器的 `sp.pref.skins`，与皮肤选择器（ui/skins.js）同一份数据。

import { t } from '../../../shared/i18n.js';
import { toast } from './toasts.js';
import { setSkins, availableSkins, SKINS_PREF } from './skins.js';

const SKINS_FILE_TYPE = 'sp-skins';
const SKINS_FILE_VERSION = 1;
const SKINS_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const CHAR_ID_RE = /^char_[0-9]+_[A-Za-z0-9_]+$/;

/** 本机已保存的皮肤选择 `{ [charId]: skinId }`。 */
export function readSkinMap() {
  try {
    const raw = JSON.parse(localStorage.getItem('sp.pref.' + SKINS_PREF) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

/** 导出负载：独立文件，不动调配 / 持有 / 自选。 */
export function serializeSkins(map) {
  return JSON.stringify({ type: SKINS_FILE_TYPE, version: SKINS_FILE_VERSION, skins: map }, null, 2);
}

/** 这份负载里有多少个干员设置了皮肤（0 = 没有可导出的）。 */
export function skinCount(map) {
  return Object.keys(map || {}).length;
}

/**
 * 当前版本可用的皮肤选择（用于渲染前的防护）。
 * 上游把皮肤按「干员 charId」跨版本共享（ui/skins.js 的说明：同一干员在各版本是同一人），
 * 所以这里不改变存储结构，只把当前版本清单里不存在的条目过滤掉，
 * 避免切换到别的版本后显示成错误立绘或空白。
 */
export function usableSkins(map) {
  const out = {};
  for (const [cid, sid] of Object.entries(map || {})) {
    if (typeof cid !== 'string' || typeof sid !== 'string') continue;
    if (!availableSkins(cid).some((x) => x.id === sid)) continue;
    out[cid] = sid;
  }
  return out;
}

/** 选择文件时先拦掉超大文件（正常负载只有几 KB）。 */
export function skinsTooLarge(size) {
  return Number(size) > SKINS_IMPORT_MAX_BYTES;
}

/**
 * 校验并清洗皮肤文件：只接受 type/version/skins 三个字段，且每一条都必须是当前版本存在的皮肤。
 * @returns {{ ok: true, skins: Record<string,string>, dropped: number, raw: number } | { ok: false, error: string }}
 */
export function parseSkinsFile(text) {
  let data = null;
  try { data = JSON.parse(text); } catch { return { ok: false, error: '导入失败：无法识别的内容' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '导入失败：无法识别的格式' };
  const extra = Object.keys(data).filter((k) => !['type', 'version', 'skins'].includes(k));
  if (extra.length) return { ok: false, error: '导入失败：无法识别的格式' };
  if (data.type != null && data.type !== SKINS_FILE_TYPE) return { ok: false, error: '导入失败：这不是皮肤文件' };
  const map = data.skins;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { ok: false, error: '导入失败：里面没有有效的皮肤条目' };
  const clean = {};
  let dropped = 0;
  for (const [cid, sid] of Object.entries(map)) {
    if (typeof cid !== 'string' || !CHAR_ID_RE.test(cid)) { dropped++; continue; }
    if (typeof sid !== 'string' || !CHAR_ID_RE.test(sid)) { dropped++; continue; }
    // 当前版本没有的皮肤（未上架 / 已下线）丢弃，避免写入无效 id
    const rows = availableSkins(cid);
    if (!rows.some((x) => x.id === sid)) { dropped++;
      continue; }
    clean[cid] = sid;
  }
  const raw = Object.keys(map).length;
  if (!Object.keys(clean).length) {
    return { ok: false, error: raw ? '导入失败：这份数据在当前版本没有可用的皮肤，未做任何改动' : '导入失败：里面没有有效的皮肤条目' };
  }
  return { ok: true, skins: clean, dropped, raw };
}

/** 应用导入结果并把结果告诉玩家。 */
export function applySkinsImport(result) {
  setSkins(result.skins);
  const n = Object.keys(result.skins).length;
  if (result.dropped) {
    toast(t('已导入 {n} 名干员的皮肤（另有 {dropped} 项无效，未导入）', { n, dropped: result.dropped }), 'warn');
  } else {
    toast(t('已导入 {n} 名干员的皮肤设置', { n }), 'success');
  }
}

export { SKINS_IMPORT_MAX_BYTES };
