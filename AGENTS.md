# AGENTS.md

Entry point for AI coding assistants (Codex, Claude Code, Cursor, Copilot …) working on this repository. It only
indexes the existing documents and their hard rules; when this file and a linked document disagree, the document wins.
Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the same material in full.

## What this is

A non-commercial fan remake of Arknights「卫戍协议：盟约」 that runs in the browser: a Node.js server (economy, rounds,
rooms) and a deterministic battle sim shared by the server and the browser. It aims to be faithful to the official mode.

## Read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the code map: where things live, data flow, golden results,
   import boundaries, where common changes start.
2. [docs/DESIGN.md](docs/DESIGN.md) — the index of the rules: current rules in `docs/design/`, each release's
   revisions and their evidence in `docs/history/`.
3. The reference for the part you touch: [docs/SIM.md](docs/SIM.md) (battle engine API, hooks, test harness),
   [docs/META.md](docs/META.md) (match flow, shop, protocol), [docs/DATA.md](docs/DATA.md) (generated data),
   [docs/I18N.md](docs/I18N.md) (interface strings), `server/sim/content/kits/README.md` (operator kits).
4. Before editing battle simulation code, read [server/sim/AGENTS.md](server/sim/AGENTS.md) for a short settlement API usage guide.
5. [docs/CI.md](docs/CI.md) — the CI jobs, the test-sharding contract (`ci-shards.json`), how to re-weigh it, the
   timeout policy, and the ways a CI measurement lies.

## Hard rules

- **Formatting.** Use two spaces for JavaScript indentation; do not introduce Tab indentation.
- **Official first.** Rules come from the official data tables (`.cache/gamedata/excel/` after setup) and
  [PRTS](https://prts.wiki/). A detail no source settles is implemented the simplest way and marked `[ASSUMED]` in the
  code and the PR. Deliberate deviations from the official mode are the maintainer's decision only.
- **Determinism.** `server/sim/` is plain ESM that runs in Node and in browsers: no Node APIs, no `Math.random`, no
  clocks, and no engine-approximated Math functions (use `server/sim/detmath.js`; ESLint and
  `test/sim/detmath.test.js` enforce it).
- **Golden results.** A refactor must not change `test/golden/*.json`. An intended gameplay change runs
  `npm run golden:update` in the same commit, and the commit / PR names every moved scenario and why
  ([test/golden/README.md](test/golden/README.md)).
- **Generated data.** Never hand-edit `data/*.json`: change `tools/build-data.mjs` and regenerate.
- **No game art in git.** `public/assets/` is ignored; never commit extracted or downloaded game files.
- **Interface strings** go through `t('…')`, with entries in every pack under `public/i18n/`
  (`node tools/i18n.mjs check --all --strict`).
- **Docs follow the code.** A rule change updates `docs/design/`, the current `docs/history/` file and the reference
  docs; run `node --test test/docs-consistency.test.js test/docs-paths.test.js`.
- **Commits and PRs**: one topic per PR; a one-line message of what changed (Chinese or English) with the issue number;
  no attribution trailers (`Co-Authored-By:`, `Generated with …`). The PR description states what, why, the sources,
  the `[ASSUMED]` points, the tests you ran (paste the summary lines) and the golden moves. No ads, payments or other
  monetisation — the project stays non-commercial.

## Verify

Run the tests of what you touched first, then everything before opening the PR:

```bash
node --test test/<area>/<file>.test.js      # targeted
npm run ci                                  # the CI checks locally (tools/ci.mjs): npm test, smoke, lint, imports, types
npm run golden                              # golden results
```

Browser suites are off by default and need Chrome: `SP_E2E=1` (UI), `SP_REAL_E2E=1` (real match, needs assets),
`RENDER_E2E=1`, `SIM_E2E=1` — see CONTRIBUTING.md §2. Battle tests are easiest with the helpers described in
docs/SIM.md (the test harness section) and the patterns in `test/content/op_siege.test.js`.

## 这是本服的生产仓库：更新 GitHub 前的必查清单

这个仓库同时是**萝卜喵公益服**的生产代码库（不只是上游的 fork）。它对应线上 30 个节点 + 匹配器 +
管理后台 + nginx。**每次要更新 GitHub（提交/推送）之前，逐条走完下面的检查**，不要跳步。

详细的背景、命令与例外说明见 [MAINTENANCE.md](MAINTENANCE.md) 的「更新 GitHub 前必查」一节。

### 1. 补丁完整性（最容易出事的一条）

本服相对上游的每一处改动都必须进 `patcher/features/`，否则上游发新版本时按
`restore → 升级 → apply` 走会**全部丢失**。

```bash
node patcher/check-coverage.mjs
```

必须输出 `未进补丁: 0`。**改了任何 `server/`、`public/`、`shared/`、`data/` 下的文件之后都要跑**；
它同时会检查「违规入库」（被 `.gitignore` 排除却仍被 Git 跟踪的文件）。

### 2. 不能提交的内容

| 禁止 | 原因 |
|---|---|
| `public/vendor/`、`public/fonts/`、`public/assets/` | AGENTS.md「No game art in git」；上游整包替换 |
| `.secrets/`（令牌、测试账号、数据库口令） | 凭据 |
| `*.key`、`privkey.pem`、`*.pem`、`*.pfx` | 私钥 |
| `node_modules/`、`logs/`、`.cache/`、`backups/` | 依赖与产物 |
| 明文 GitHub PAT / 数据库密码 | 一律走 `.secrets/` 或环境变量 |
| 本机绝对路径、Windows 用户名 | 仓库是**公开**的 |

**新增文件前先想一遍它属于哪一类。** `git add -A` 之后、`commit` 之前，检查一次
`git diff --cached --name-only` 有没有混进上面的东西。

### 3. 敏感信息不能写死在代码里

仓库公开，因此：

- 部署根目录用 `process.env.SP_ROOT || __dirname`（参考 `ecosystem.config.cjs`）
- pm2 / PM2_HOME 用 `APPDATA` / `USERPROFILE` 推导，不要写 `C:\Users\<用户名>\...`
- 资源站域名读 `data/config.json` 的 `assetOrigin` 或环境变量 `SP_ASSET_ORIGIN`，
  不要在前端硬编码域名字面量
- 站点相关的密钥一律走 `.secrets/` 或环境变量

### 4. 改到运行时代码时：区分「刷新生效」与「重启生效」

| 改动位置 | 生效方式 |
|---|---|
| `public/js`、`public/css`、`shared/`、`data/`、`mm/client.js` | 玩家刷新页面即可 |
| `server/**`（含 `server/net.js`、`server/match/**`） | **必须重启节点** |

`healthz` 的 `build` 字段**只覆盖** `public/index.html`、`public/js`、`public/css`、`server/sim`、
`shared`、`data`——**不包含 `server/net.js`、`server/lobby.js`、`server/match/**`**。
所以「所有节点 build 相同」**不能**证明服务端代码已更新，要用进程启动时间对比文件 mtime。

线上重启有硬约束：**正在对局的节点一律不动**（见 MAINTENANCE.md「重启纪律」）。

### 5. 提交前

```bash
git rev-list --left-right --count origin/custom/production...HEAD   # 必须是 0  0
node patcher/check-coverage.mjs                                     # 未进补丁: 0
git status --short                                                  # 无意外文件
```

`git diff --cached --name-only | Select-String '\.key$|privkey|\.pem$|\.secrets'` 必须为空。
