/**
 * v2.3.93 内置默认技能（狗头军师 goutoujunshi）—— 真实机制实测
 * ============================================================================
 * 做法沿用 scripts/verify-skills.mjs 的范式（项目无 jest）：
 *   1. esbuild 把**真实的** electron/skills.ts + electron/builtinSkills.ts 打成 CJS
 *      （electron/fs/path 外部化）；
 *   2. require 钩子注入 electron stub（app.getPath → 临时目录）→ 让生产代码真的去读 /
 *      写我们seed 的 skills.json；
 *   3. 驱动**真实导出函数** loadSkills / listSkills / seedBuiltinSkills / restoreBuiltinSkill /
 *      getSkillsForChat / setSkillEnabled / buildSkillsPrompt / deleteSkill / flushSkills，
 *      断言全部基于真实落盘文件内容（无生产代码测试钩子）。
 *
 * 断言分组：
 *   A. 种子写入：首次访问自动种入 / 字段正确（name·description·scope·enabled·builtin 标记）/
 *      正文完整 / id 稳定 / 落盘真实 skills.json
 *   B. 幂等：二次载入不新增、不覆盖；反复调用 seedBuiltinSkills 无副作用
 *   C. **安全边界**：种子正文不含任何 scripts/ 可执行内容；记录里没有脚本字段；
 *      序列化后不含脚本路径；references/ 未被打包（仅作文本引用）
 *   D. 用户导入的同名技能不被内置覆盖（让位策略）
 *   E. 升级策略：未改过 → 静默刷新正文；改过 → 保留用户版本 + builtinUpdateAvailable；
 *      删除过 → 不复活，且可一键恢复
 *   F. 作用域与启停：scope=global 任意聊天生效；enabled=false 后不再被选中
 *   G. i18n：10 处新键齐全且非空，各locale 键数一致；UI/文档均已载明「不执行脚本」
 *
 * 用法：export PATH=.../node/22.22.2-5:$PATH && node scripts/verify-builtin-skill.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const ROOT = resolve(import.meta.dirname, '..');
const workDir = mkdtempSync(join(tmpdir(), 'builtin-skill-verify-'));
const STORE_PATH = join(workDir, 'skills.json');
const req = createRequire(join(workDir, 'harness.cjs'));

// ---------------------------------------------------------------- 1) 打包真实源码
const bundle = await build({
  entryPoints: [join(ROOT, 'electron/skills.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  write: false,
  logLevel: 'silent',
  external: ['electron', 'fs', 'path'],
});
const outFile = join(workDir, 'skills.cjs');
writeFileSync(outFile, bundle.outputFiles[0].text, 'utf-8');

// ---------------------------------------------------------------- 2) require 钩子注入 stub
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
const electronStub = { app: { getPath: () => workDir } };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};

/** 加载一份全新的 skills 模块实例（模块级 store 为空 → 首次访问触发 loadSkills + 种子） */
function loadSkillsModule() {
  delete Module._cache[outFile];
  return req(outFile);
}
function readStore() {
  return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
}
function seedStore(obj) {
  writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), 'utf-8');
}
/** 等待 500ms 防抖落盘 */
const settle = () => new Promise((r) => setTimeout(r, 700));

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${extra ? '   [' + extra + ']' : ''}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL  ${label}${extra ? '   [' + extra + ']' : ''}`);
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}

const GOUTOU = 'builtin-skill-goutoujunshi';

// ================================================================ A：种子写入
section('A  首次访问自动种入内置技能（无需用户手动导入）');
let firstBody = '';
{
  ok(existsSync(STORE_PATH) === false, 'A0 起始状态：skills.json 尚未创建');
  const M = loadSkillsModule();
  // 只调 listSkills（最普通的读路径）——种子必须由「首次访问存储」自动触发，
  // 不能依赖 main.ts 显式调用（这样任何入口先进技能层都能拿到）
  const list = M.listSkills();
  ok(list.length === 1, 'A1 首次访问即自动种入 1 条内置技能（无需手动导入）', `count=${list.length}`);

  const s = list[0];
  ok(s.id === GOUTOU, 'A2 稳定 id 为 builtin-skill-goutoujunshi', `id=${s.id}`);
  ok(s.name === 'goutoujunshi', 'A3 name 来自 frontmatter', `name=${s.name}`);
  ok(
    s.description.startsWith('恋爱军师与情绪支持 skill。') && s.description.includes('心动'),
    'A4 description 完整解析（AI 判断触发的唯一依据）',
    `len=${s.description.length}`
  );
  ok(s.scope === 'global', 'A5 scope=global（任意聊天都生效）', `scope=${s.scope}`);
  ok(s.enabled === true, 'A6 安装即启用（enabled=true，用户可随时关）', `enabled=${s.enabled}`);
  ok(s.builtin === true, 'A7 带 builtin 标记（UI 据此显示「内置」徽标）', `builtin=${s.builtin}`);
  ok(s.builtinVersion === 1, 'A8 builtinVersion 已记账（升级策略的依据）', `v=${s.builtinVersion}`);
  ok(s.builtinUpdateAvailable === undefined, 'A9 首次种入不标记「有更新」');

  firstBody = s.body;
  ok(firstBody.length > 3000, 'A10 正文完整导入（非截断）', `len=${firstBody.length}`);
  ok(
    firstBody.startsWith('# 狗头军师') &&
      firstBody.includes('## 核心原则') &&
      firstBody.includes('## 每次分析') &&
      firstBody.includes('## 安全边界'),
    'A11 正文含上游关键章节（核心原则 / 每次分析 / 安全边界）'
  );
  // frontmatter 剥离检查：正文不能以 --- 开头，也不能残留 name:/description: 元信息行
  // （注意正文里的 Markdown 表格含 `| --- | --- |`，不能简单断言「不含 ---」）
  ok(
    !firstBody.startsWith('---') &&
      !/^name:\s/m.test(firstBody) &&
      !/^description:\s/m.test(firstBody),
    'A12 正文已剥离 frontmatter，无残留元信息行'
  );
  ok(s.truncated !== true, 'A13 正文未被截断（远低于 SKILL_BODY_MAX=20000）', `len=${firstBody.length}`);
  ok(!!s.importedAt, 'A14 importedAt 已生成');

  // 真实落盘
  ok(existsSync(STORE_PATH), 'A15 种子同步落盘 skills.json（启动即写盘，不等防抖窗口）');
  const f = readStore();
  ok(f.skills.length === 1 && f.skills[0].id === GOUTOU, 'A16 落盘内容正确', `count=${f.skills.length}`);
  ok(f.builtinVersions && f.builtinVersions[GOUTOU] === 1, 'A17 落盘含 builtinVersions 记账', JSON.stringify(f.builtinVersions));
  ok(Array.isArray(f.dismissedBuiltins) && f.dismissedBuiltins.length === 0, 'A18 落盘含 dismissedBuiltins 空账本');
}

// ================================================================ B：幂等
section('B  幂等：二次访问/ 重复调用不重复写入、不覆盖');
{
  const M = loadSkillsModule(); // 模拟重启：重新读同一个 skills.json
  const list = M.listSkills();
  ok(list.length === 1, 'B1 重启后仍只有 1 条（不重复种入）', `count=${list.length}`);
  ok(list[0].body === firstBody, 'B2 正文未被二次启动改写');
  ok(list[0].importedAt === readStore().skills[0].importedAt, 'B3 importedAt 未被刷新（无意义写入）');

  // 用户启停后重启：启停状态必须被尊重，不能被种子重置
  M.setSkillEnabled(GOUTOU, false);
  await settle();
  const M2 = loadSkillsModule();
  const off = M2.listSkills()[0];
  ok(off.enabled === false, 'B4 用户停用后重启，种子不把它改回启用（尊重用户选择）', `enabled=${off.enabled}`);

  // 重复调用 seedBuiltinSkills 无副作用
  const M3 = loadSkillsModule();
  const before = JSON.stringify(M3.listSkills());
  const r1 = M3.seedBuiltinSkills();
  const r2 = M3.seedBuiltinSkills();
  ok(
    r1.seeded.length === 0 && r1.refreshed.length === 0,
    'B5 重复调用 seedBuiltinSkills 无新增/无刷新',
    `seeded=${r1.seeded.length} refreshed=${r1.refreshed.length}`
  );
  ok(JSON.stringify(M3.listSkills()) === before, 'B6 重复调用不改变任何字段（真正幂等）');
  ok(r2.seeded.length === 0, 'B7 第三次调用同样无操作');
}

// ================================================================ C：安全边界（关键）
section('C  安全边界：scripts/ 未导入未执行，references/ 未打包');
{
  const M = loadSkillsModule();
  const s = M.listSkills()[0];
  const json = JSON.stringify(s);

  ok(
    s.scriptBlocked !== true && !s.scriptFields,
    'C1 种子记录没有任何脚本字段标记（frontmatter 未声明 scripts）',
    `scriptBlocked=${s.scriptBlocked}`
  );
  ok(!/scripts\//.test(json), 'C2 落盘记录中不含任何 scripts/ 路径', `/scripts\\//=${/scripts\//.test(json)}`);
  ok(!/\.(sh|py|js|ts|ps1|bat)\b/.test(s.body), 'C3 正文不含任何可执行脚本文件名', '');
  ok(!/child_process|exec\(|spawn\(|require\(/.test(s.body), 'C4 正文不含任何调用/执行代码');

  // references/ 只是原文的「查阅建议」文本，本机不存在这些文件 —— UI 与文档必须如实告知
  ok(s.body.includes('references/'), 'C5 正文保留了 references/ 路径（上游原文的查阅路由表）');
  ok(
    M.listDismissedBuiltinSkills !== undefined,
    'C6 生产代码提供 listDismissedBuiltinSkills（UI 恢复入口的数据源）'
  );

  // 脚本字段拦截机制本身仍然生效（回归：种子走的是与用户导入完全相同的解析路径）
  const evil = M.parseSkillMarkdown(
    '---\nname: 恶意技能\ndescription: 测试\nscripts:\n  - run.sh\nexec: rm -rf /\n---\n正文'
  );
  ok(
    evil.scriptBlocked === true && !JSON.stringify(evil).includes('rm -rf'),
    'C7 回归：技能层脚本字段拦截仍生效（种子与导入同一条解析路径）',
    `fields=${evil.scriptFields}`
  );
}

// ================================================================ D：同名用户技能让位
section('D  用户已自行导入同名技能 → 内置让位，不覆盖用户资产');
{
  // 真实场景：用户**先**导入了自己的同名技能（此刻内置还没种入），随后升级到含内置的版本。
  // 直接构造这样的 skills.json，避免依赖「先种后删」的顺序（那会走进dismissedBuiltins 分支）。
  seedStore({
    version: 2,
    skills: [
      {
        id: 'skill_user_own',
        name: 'goutoujunshi',
        description: '我自己的版本',
        scope: 'global',
        body: '这是我自己写的正文。',
        enabled: true,
        importedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    builtinVersions: {},
    dismissedBuiltins: [],
  });
  const M = loadSkillsModule();
  const list = M.listSkills();
  const mine = list.find((s) => s.id !== GOUTOU);
  ok(list.length === 1, 'D1 内置未注入，用户自有同名技能仍是唯一一条', `count=${list.length}`);
  ok(!!mine, 'D2 用户自有同名技能存在', `name=${mine && mine.name}`);
  ok(mine.description === '我自己的版本' && mine.body === '这是我自己写的正文。', 'D3 用户版本内容未被内置覆盖');
  ok(!list.some((s) => s.builtin === true), 'D4 不注入内置条目（避免同名重复、避免覆盖用户资产）');
  const r = M.seedBuiltinSkills();
  ok(r.userOwned.includes(GOUTOU), 'D5 seedBuiltinSkills 明确报告 userOwned（让位而非冲突）', `userOwned=${r.userOwned}`);
  ok(M.listSkills().length === 1, 'D6 重复调用仍不注入（让位判定稳定）');
}

// ================================================================ E：升级策略
section('E  升级策略：未改过→静默刷新；改过→保留用户版本；删过→不复活可恢复');
{
  // E1/E2：用户**改过**正文 → 升级不覆盖，标记有更新
  rmSync(STORE_PATH, { force: true });
  const M = loadSkillsModule();
  M.listSkills();
  const target = M.listSkills()[0];
  target.body = '用户自己改过的正文（模拟未来版本的手动编辑）';
  target.builtinVersion = 0; // 假装是旧版种下的
  M.flushSkills();

  const M2 = loadSkillsModule(); // 升级后重启
  const s2 = M2.listSkills()[0];
  ok(s2.body === '用户自己改过的正文（模拟未来版本的手动编辑）', 'E1 用户改过的正文被保留，未被内置覆盖');
  ok(s2.builtinUpdateAvailable === true, 'E2 标记 builtinUpdateAvailable（UI 提示「内置技能有更新」）');

  // E3：restoreBuiltinSkill 用户确认后覆盖回内置版，且清掉标记
  const restored = M2.restoreBuiltinSkill(GOUTOU);
  ok(!!restored && restored.body !== '用户自己改过的正文（模拟未来版本的手动编辑）', 'E3 restoreBuiltinSkill 可覆盖回内置版');
  ok(restored.builtinUpdateAvailable === false, 'E4 恢复后清掉 builtinUpdateAvailable');
  ok(restored.builtin === true && restored.builtinVersion === 1, 'E5 恢复后 builtin 标记与版本正确');
  M2.flushSkills();
  const after = loadSkillsModule().listSkills()[0];
  ok(after.body === firstBody, 'E6 恢复结果已落盘，重启后一致（与首次种子正文逐字相同）', `len=${after.body.length}`);

  // E7：非内置技能不可越权恢复
  const userSkill = M2.importSkill('---\nname: 我自己的\ndescription: d\n---\n正文', 'x.md').skill;
  ok(M2.restoreBuiltinSkill(userSkill.id) === undefined, 'E7 restoreBuiltinSkill 拒绝非内置技能（不越权覆盖用户资产）');

  // E8/E9：用户删除内置技能 → 不复活
  M2.deleteSkill(GOUTOU);
  await settle();
  ok(M2.listSkills().some((s) => s.id === GOUTOU) === false, 'E8 删除立即生效');
  const M3 = loadSkillsModule(); // 重启
  ok(M3.listSkills().some((s) => s.id === GOUTOU) === false, 'E9 重启后不复活（尊重显式删除，不擅自装回）');
  ok(readStore().dismissedBuiltins.includes(GOUTOU), 'E10 删除被记账到 dismissedBuiltins', JSON.stringify(readStore().dismissedBuiltins));

  // E11：可一键恢复
  const dismissed = M3.listDismissedBuiltinSkills();
  ok(dismissed.length === 1 && dismissed[0].id === GOUTOU, 'E11 listDismissedBuiltinSkills 列出可恢复项', `n=${dismissed.length}`);
  const back = M3.restoreBuiltinSkill(GOUTOU);
  ok(!!back && back.body === firstBody, 'E12 一键恢复装回内置技能且正文一致');
  ok(back.enabled === true, 'E13 恢复已删除的内置技能 = 重新安装，回到内置默认「启用」', `enabled=${back.enabled}`);
  ok(M3.listSkills().some((s) => s.id === GOUTOU && s.enabled === true), 'E13b 恢复后重新进入生效列表');

  // E14：恢复**已存在但被停用**的记录 → 保留停用状态（不擅自替用户开启）
  const M4 = loadSkillsModule();
  M4.setSkillEnabled(GOUTOU, false);
  const restored2 = M4.restoreBuiltinSkill(GOUTOU);
  ok(!!restored2 && restored2.enabled === false, 'E14 恢复已存在但停用的记录时保留停用状态', `enabled=${restored2 && restored2.enabled}`);
}

// ================================================================ F：作用域与启停
section('F  作用域生效与启停（内置技能与用户技能走同一套解析）');
{
  rmSync(STORE_PATH, { force: true });
  const M = loadSkillsModule();
  M.listSkills();

  // F1：scope=global → 任意聊天都被选中（单聊 / 群聊 / 不同角色）
  const single = M.getSkillsForChat('single', 'alice', 'alice');
  const group = M.getSkillsForChat('group', 'g1', 'bob');
  const other = M.getSkillsForChat('single', 'zed', 'zed');
  ok(
    single.some((s) => s.id === GOUTOU) && group.some((s) => s.id === GOUTOU) && other.some((s) => s.id === GOUTOU),
    'F1 scope=global 在单聊/群聊/任意角色下都生效',
    `${single.length}/${group.length}/${other.length}`
  );

  // F2：真的进了系统提示词
  const prompt = M.buildSkillsPrompt(single);
  ok(prompt.includes('【可用技能】') && prompt.includes('<skill name="goutoujunshi"'), 'F2 内置技能进入注入段', '');
  ok(prompt.includes('把“对用户最有利”理解为情绪稳定'), 'F3 正文完整注入提示词（关键段落抽样）');

  // F4：停用后不再被选中
  M.setSkillEnabled(GOUTOU, false);
  ok(M.getSkillsForChat('single', 'alice', 'alice').length === 0, 'F4 停用后 getSkillsForChat 不再选中它');
  ok(M.buildSkillsPrompt(M.getSkillsForChat('single', 'alice', 'alice')) === '', 'F5 停用后整段不注入（省 token）');
  await settle();
  const M2 = loadSkillsModule();
  ok(M2.getSkillsForChat('single', 'alice', 'alice').length === 0, 'F6 停用状态已落盘，重启后仍停用');

  // F7：重新启用
  M2.setSkillEnabled(GOUTOU, true);
  await settle();
  ok(loadSkillsModule().getSkillsForChat('single', 'alice', 'alice').length === 1, 'F7 可重新启用（可以开可以关）');
}

// ================================================================ G：i18n 与文档
section('G  i18n（10 处）与文档口径一致性');
{
  const fs = await import('node:fs');
  const NEW = [
    'skill.builtinBadge', 'skill.builtinSource', 'skill.builtinNotice', 'skill.builtinDetail',
    'skill.builtinRemoved', 'skill.builtinUpdate', 'skill.restoreBuiltin', 'skill.restoreConfirm',
    'skill.restored', 'skill.restoreFailed', 'skill.emptyFiltered',
  ];
  const tr = fs.readFileSync(join(ROOT, 'src/i18n/translations.ts'), 'utf-8');
  const cnt = new Map();
  for (const m of tr.matchAll(/'(skill\.[^']+)':/g)) cnt.set(m[1], (cnt.get(m[1]) || 0) + 1);
  const missTr = NEW.filter((k) => cnt.get(k) !== 2);
  ok(missTr.length === 0, 'G1 translations.ts 中 11 个新键 zh+en 各一处', missTr.join(',') || `共 ${cnt.size} 键`);

  const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
  const keySets = locales.map((l) => [l, JSON.parse(fs.readFileSync(join(ROOT, `src/i18n/locales/${l}.json`), 'utf-8'))]);
  const base = Object.keys(keySets[0][1]).sort();
  for (const [l, o] of keySets) {
    ok(Object.keys(o).length === base.length, `G2 ${l}.json 键数与 de 一致`, `${Object.keys(o).length} 键`);
    const missing = NEW.filter((k) => !(k in o));
    ok(missing.length === 0, `G3 ${l}.json 含全部新键`, missing.join(','));
    const empty = NEW.filter((k) => !o[k] || !String(o[k]).trim());
    ok(empty.length === 0, `G4 ${l}.json 新键非空`, empty.join(','));
    // 占位符一致性：含 {name} 的键必须在所有语言里保留
    const bad = NEW.filter((k) => {
      const m = new RegExp(`'${k.replace('.', '\\.')}':\\s*'([^']*)'`).exec(tr);
      if (!m) return true;
      return [...m[1].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).some((v) => !String(o[k]).includes(`{${v}}`));
    });
    ok(bad.length === 0, `G5 ${l}.json 占位符与基准一致`, bad.join(','));
  }

  // zh/en 基准组自检
  const zhBlock = tr.slice(tr.indexOf('  zh: {'), tr.indexOf('  en: {'));
  const enBlock = tr.slice(tr.indexOf('  en: {'));
  for (const [name, block] of [['zh', zhBlock], ['en', enBlock]]) {
    const miss = NEW.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}':`).test(block));
    const empt = NEW.filter((k) => {
      const m = new RegExp(`'${k.replace('.', '\\.')}':\\s*'([^']*)'`).exec(block);
      return !m || !m[1].trim();
    });
    ok(miss.length === 0 && empt.length === 0, `G6 translations.ts ${name} 组键齐全且非空`, [...miss, ...empt].join(','));
  }
  // zh 文案必须如实告知 scripts/ 未导入、references/ 未打包
  const zhDetail = /'skill\.builtinDetail':\s*'([^']*)'/.exec(tr);
  ok(
    !!zhDetail && zhDetail[1].includes('scripts/') && zhDetail[1].includes('references/') &&
      zhDetail[1].includes('不会被执行') && zhDetail[1].includes('未打包'),
    'G7 zh 文案如实载明「scripts/ 未导入且不执行、references/ 未打包」'
  );

  // 文档口径：使用说明.md 与 GuideView.tsx 两处必须一致（项目铁律）
  const guide = fs.readFileSync(join(ROOT, 'src/components/GuideView.tsx'), 'utf-8');
  const manual = fs.readFileSync(join(ROOT, '使用说明.md'), 'utf-8');
  const changelog = fs.readFileSync(join(ROOT, '版本更新记录.md'), 'utf-8');
  const builtinSrc = fs.readFileSync(join(ROOT, 'electron/builtinSkills.ts'), 'utf-8');
  ok(
    guide.includes('goutoujunshi') && guide.includes('scripts/') && guide.includes('references/'),
    'G8 GuideView.tsx guide-skill 段载明内置技能与「脚本不执行 / references 未打包」'
  );
  ok(
    manual.includes('goutoujunshi') && manual.includes('scripts/') && manual.includes('references/'),
    'G9 使用说明.md 技能章节载明内置技能与「脚本不执行 / references 未打包」'
  );
  ok(
    changelog.includes('## v2.3.93') && changelog.includes('最新发版：**v2.3.93**'),
    'G10 版本更新记录.md 顶部为 v2.3.93 且含该版本条目'
  );
  ok(
    builtinSrc.includes('MIT') && builtinSrc.includes('shengjidaguai-china/goutoujunshi'),
    'G11 builtinSkills.ts 注明上游仓库与 MIT 许可来源'
  );
  ok(
    !builtinSrc.includes('scripts/') || !/GOUTOUJUNSHI_MARKDOWN_LINES[\s\S]*scripts\//.test(builtinSrc),
    'G12 内置数据里不含 scripts/ 目录内容（仅注释中提及来源说明）'
  );
  // skills.json 依然不进 store.json（回归）
  const dbSrc = fs.readFileSync(join(ROOT, 'electron/db.ts'), 'utf-8');
  ok(!/interface Store \{[^}]*skills/s.test(dbSrc), 'G13 db.ts Store 接口仍无 skills 字段（未混入 store.json）');
  console.log(`  · skill.* 键：locales 每份 ${base.length} 键（v2.3.92 为 ${base.length - NEW.length}）`);
}

// ================================================================ 汇总
console.log(`\n${'='.repeat(60)}`);
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
rmSync(workDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);