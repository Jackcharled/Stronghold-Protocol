// 验证 5–20 人大厅的两个实验规则真的生效：
//   1. 允许重复选择策略（allowRepeat）：队伍里可以出现重复盟约
//   2. 悬赏决策（capacityExperiment）：可以多人悬赏同一个目标
//   3. 两者都是「同时选」而不是「一个一个按顺序」
//
// 这三件事在 0.3.3 升级上游时从 phases.js / spDraft.js 里整段丢掉了，
// 只剩 Match.js 的 concurrentDraft() 和 views.js 的下发字段，所以功能是「半个」的。
//   node test\hall-concurrent-draft.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const phases = fs.readFileSync('node-1/server/match/match/phases.js', 'utf8');
const spDraft = fs.readFileSync('node-1/server/match/match/spDraft.js', 'utf8');
const matchJs = fs.readFileSync('node-1/server/match/Match.js', 'utf8');

console.log('=== 1) 允许重复选择策略（盟约）===\n');
check('★ allowRepeat 时 bandTaken 恒为 false（不再判「队友已选」）',
  /bandTaken\(bandId, playerId\) \{\s*\n\s*if \(this\.allowRepeat\) return false;/.test(phases));
check('allowRepeat 由 capacityExperiment 把关（只在 5–20 人房生效）',
  /this\.allowRepeat = this\.capacityExperiment && this\.experimental\.allowRepeat === true/.test(matchJs));

console.log('\n=== 2) 悬赏决策可重复 ===\n');
// 5–20 人房（capacityExperiment）不判「已被选走」；4 人局仍判重
check('★ 大厅房不判「已被选走」（capacityExperiment 短路）',
  /if \(!this\.capacityExperiment && this\.sp\?\.taken\[card\.idx\] != null\) return false;/.test(spDraft),
  'spCardAvailable 里的 capacityExperiment 判断');
check('★ 重复选中时克隆卡片（每人独立副本，不互相影响）',
  /const card = this\.capacityExperiment \? structuredClone\(s\.cards\[idx\]\) : s\.cards\[idx\]/.test(spDraft));
check('4 人局仍然按 taken 判重', /!this\.capacityExperiment && this\.sp\?\.taken\[card\.idx\] != null/.test(spDraft));

console.log('\n=== 3) 同时选（并发草稿）而不是按顺序 ===\n');
check('★ 盟约草稿有并发实现 _concurrentBandStep', /_concurrentBandStep\(\)/.test(phases));
check('★ startDraftTurn 在并发时走并发分支', /if \(d\.concurrent\) \{ this\._concurrentBandStep\(\); return; \}/.test(phases));
check('★ 并发时 draftTurn 返回 null（没有「当前这一位」）', /if \(!d \|\| d\.concurrent\) return null;/.test(phases));
check('★ 悬赏草稿有并发实现 _concurrentSpStep', /_concurrentSpStep\(\)/.test(spDraft));
check('★ 悬赏 startSpTurn 在并发时走并发分支', /if \(s\.concurrent\) \{ this\._concurrentSpStep\(\); return; \}/.test(spDraft));
check('★ 并发时 spTurn 返回 null', /if \(!s \|\| s\.concurrent\) return null;/.test(spDraft));

console.log('\n=== 4) 并发下玩家仍能选（不能被轮次卡住）===\n');
check('★ 盟约 pickBand 并发时跳过轮次校验',
  /if \(!this\.draft\.concurrent && this\.draftTurn\(\) !== ps\.playerId\) return fail\(ERR\.NOT_YOUR_TURN\)/.test(phases));
check('★ 悬赏 pickCard 并发时跳过轮次校验',
  /if \(!this\.sp\.concurrent && this\.spTurn\(\) !== ps\.playerId\) return fail\(ERR\.NOT_YOUR_TURN\)/.test(spDraft));
check('★ 盟约并发时没有「跳过」（没人在后面等着让位）',
  /if \(d\.concurrent\) return fail\(ERR\.WRONG_PHASE, 'no skip in a concurrent draft'\)/.test(phases));
check('★ 并发草稿的 skipsLeft 为 0', /const skips = this\.isSolo \|\| concurrent \? 0/.test(phases));

console.log('\n=== 5) AI 与玩家同规则（原始设计）===\n');
check('AI 也受 allowRepeat 影响（bandTaken 里统一判断，不区分 AI）',
  !/bandTaken[\s\S]{0,80}isBot/.test(phases), 'bandTaken 不应按 isBot 分支');
check('并发时 AI 每个座位只排队一次（botQueued）',
  /d\.botQueued\?\.has\(target\.playerId\)/.test(phases) && /s\.botQueued\?\.has\(target\.playerId\)/.test(spDraft));

console.log('\n=== 6) 前端也认并发 ===\n');
const draftJs = fs.readFileSync('node-1/public/js/ui/gameLogic/draft.js', 'utf8');
const bandDraft = fs.readFileSync('node-1/public/js/screens/bandDraft.js', 'utf8');
check('draftMyTurn 处理 concurrent', /if \(d\.concurrent === true\) return /.test(draftJs));
check('★ 盟约界面用 draftMyTurn 判「轮到我」（并发时人人可点）',
  /const myTurn = !myPick && draftMyTurn\(draft, myId, solo\)/.test(bandDraft));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
