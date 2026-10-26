# 皮肤补全记录（2026-10-26）

## 问题

排查玩家反馈「某个干员只有头像没有模型」时发现：**19 个干员在本服一个皮肤都没有**，
而官方 `skin_table.json` 里它们各有 3–5 个皮肤。最典型的是 `char_133_mm`（梅，MAIN）。

- 这些干员的**本体模型是完整的**（前后模型、头像、立绘在资源站上实测全 200）
- 缺的只是**皮肤模型**：资源站上也不存在，属「从未提取并上传」

> 这不是第一次：`missing-assets-README.md` 记录过上一轮补全，**同样是这 19 个干员**。
> 那次补的是本体（头像/立绘/前后模型），漏了皮肤。

## 做了什么

从 fexli 镜像（`gh-proxy.com` + `raw.githubusercontent.com/fexli/ArknightsResource`）重新提取，
**26 个皮肤模型全部导入**，`assets.json` 的皮肤覆盖率从 210/229 → **229/229（100%）**。

| 干员 | 皮肤模型 |
|---|---|
| char_109_fmout | char_109_fmout_epoque_2 |
| **char_133_mm（梅）** | **char_133_mm_summer_20** |
| char_135_halo | char_135_halo_epoque_25 |
| char_198_blackd | char_198_blackd_winter_1 · char_198_blackd_as_1 |
| char_215_mantic | char_215_mantic_epoque_4 · char_215_mantic_epoque_19 |
| char_218_cuttle | char_218_cuttle_epoque_12 |
| char_230_savage | char_230_savage_sale_17 · char_230_savage_boc_8 · char_230_savage_kitchen_3 |
| char_243_waaifu | char_243_waaifu_whirlwind_2 |
| char_271_spikes | char_271_spikes_winter_2 · char_271_spikes_unveiling_1 |
| char_304_zebra | char_304_zebra_wild_6 |
| char_345_folnic | char_345_folnic_wild_4 |
| char_348_ceylon | char_348_ceylon_summer_13 |
| char_355_ethan | char_355_ethan_epoque_7 |
| char_4004_pudd | char_4004_pudd_snow_5 |
| char_4045_heidi | char_4045_heidi_epoque_24 |
| char_4119_wanqin | char_4119_wanqin_epoque_41 |
| char_422_aurora | char_422_aurora_boc_4 |
| char_449_glider | char_449_glider_epoque_17 · char_449_glider_nian_10 |
| char_473_mberry | char_473_mberry_epoque_14 · char_473_mberry_nian_9 |

> `_1` / `_2`（精一 / 精二）官方就是**复用本体模型**，镜像上 404 属正常，不需要单独文件。

## 立绘是有意留空的

`deploy\skin-import2.mjs` 原本会默认下载 `char_002_amiya_2.png`（阿米娅的立绘）——
那会**张冠李戴**，界面上「梅」的皮肤会显示成阿米娅的立绘。

新脚本的规则：**只有资源站上确实存在该皮肤的立绘时才写**，否则不写。
这批皮肤的立绘（`/assets/char/skin/<model>.png`）在资源站和两个镜像上**都还没有**，
所以清单里没有 `portrait` 字段，界面会回落显示**该干员本体的立绘**（正确的人，只是没换衣服）。

## 两个已修的问题

导入完成后发现界面显示「`char_133…`」而不是皮肤名，且立绘是别人的。两个原因：

| 问题 | 原因 | 修复 |
|---|---|---|
| 名字显示成 `char_133…` | 导入脚本把 `name` 写成了模型 ID | 从官方 `skin_table.json` 的 `displaySkin.skinName` 取真名（如「夏卉 FA054」） |
| 立绘是别人的 | 脚本默认用 `char_002_amiya_2.png` | 删掉该引用；只有资源站真有该皮肤立绘时才写 |

修复脚本：`tools\fix-skin-names-portraits.mjs`。
`test\op-skin-coverage.mjs` 加了对应两条断言（显示名不能是模型 ID、立绘不能引用别的干员），
破坏性测试确认两条都能抓住（把这两个 bug 塞回去会变红）。

## 资源站状态

`assets.json` 已引用这些皮肤的 CDN 地址，但**资源站上对应文件还没上传**，所以现在请求是 404。
那边设备会自行更新上传，**不需要再打补全包**。

上传完成后的验证：
```
node test\cdn-assets-exist.mjs --only char_133_mm     # 应 9/9 = 200
```
或单个：
```
HEAD https://assets.luobomiao.love/assets/spine/op/char_133_mm/char_133_mm_summer_20/front/char_133_mm_summer_20.skel
```

## 注意：上传前选中这些皮肤会显示不出模型

`assets.js` 的 `spineEntry()` 只在**清单层面**回落：皮肤条目没有可用模型时，返回干员本体模型。
但只要清单里声明了皮肤（`validSpine` 通过），就会返回**皮肤**的 entry，
文件 404 属于**加载失败**，不会自动换成本体 —— 会走「重试 + cache-buster」那条路径
（`units.js` 的 `SPINE_RETRY_MS` / `assets.js` 的 `spineBust`），一直重试直到资源站上传好。

所以**上传完成前，玩家若选中这 26 个皮肤中的某一个，该干员会一直显示菱形头像**（不再是灰块）。
上传完成后自动恢复，不需要玩家做任何操作。

如果希望上传前的窗口期更稳妥，可以先把这 26 个皮肤从 `assets.json` 摘掉，
上传完成后再加回来。**当前没有摘**，因为默认皮肤是本体模型，只有主动选皮肤才会触发。

## 相关脚本

| 脚本 | 作用 |
|---|---|
| `tools\probe-skin-mirror.mjs` | 探测 fexli 镜像上有哪些皮肤模型可下载 |
| `tools\import-missing-skins.mjs` | 批量导入（幂等；`--dry-run` / `--only <charId>`） |
| `tools\normalize-skin-urls.mjs` | 把相对路径统一成 CDN 绝对地址 |
| `test\op-skin-coverage.mjs` | 体检：官方有皮肤的干员本服是否都导入了 |

## 另外两项（正常，不是缺口）

- **精二头像缺 16 个**：都是 `char_600_cpione` ~ `char_615_acspec` 这类**后备干员**（外勤医疗等临时单位），官方本身就没有精二。
- **Back 模型缺 4 个**：`char_1012_skadi2`、`char_291_aglina`、`char_4134_cetsyr`、`char_4045_heidi`。
