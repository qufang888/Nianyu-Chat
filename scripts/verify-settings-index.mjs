// v2.3.97 验证：设置搜索索引 + 分类跳转
// 用法：node scripts/verify-settings-index.mjs
//
// 为什么需要这个脚本：这些 bug 已经**复发两次**（v2.3.94 修过一次，只修对一半）。
// 根因都是「靠人肉维护清单」：静态索引表要人同步、依赖数组要人记得加、分类 ref 要人配。
// 所以这里全部改成可自动断言的形式 —— 每次改动跑一遍，回归立刻暴露。
//
// 本脚本做两件事：
//   1) 解析 src/components/Settings.tsx 源码，做结构性断言（9 组，见下）。
//   2) 用真实的 DOM 语义校验「静态索引每条锚点在源码里都有对应 DOM 锚点」。
//
// 不做真实浏览器渲染（项目无 jsdom 依赖，且 Electron 环境跑不起），改为源码级解析 ——
// 对「静态表与 DOM 是否对应」这类问题，源码解析已经足够且更稳定。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src', 'components', 'Settings.tsx');
const rawCode = fs.readFileSync(SRC, 'utf8');
// 断言一律基于「去注释后的代码」，否则修复说明里的注释文字会被当成代码来匹配。
const code = stripComments(rawCode);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : ''));
  }
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

/**
 * 去掉注释，保留真实代码。
 * 为什么必须去注释：本脚本要断言「代码里没有 X 分支」，而修复说明的**注释里往往就写着 X**
 * （例如我们在 scrollToCat 上写的注释原文包含 `if (id === 'cat-models')`）。
 * 不去注释就会把注释当成代码，门禁失效。
 *
 * 为什么用「整行注释」而不是逐字符状态机：JSX 文本里的撇号（don't）、正则字面量、
 * 模板串、URL 里的 `//` 都会让状态机误判（本脚本第一版就栽在这）。
 * 只剥离「整行都是注释」的行 + 块注释，行为可预测；代价是行尾注释不剥离 ——
 * 这一点由下面的sanity 断言兜底（若哪天有人在行尾写下被禁字符串，断言会失败并暴露）。
 */
function stripComments(src) {
  // 先去块注释 /* ... */（含 JSX 里的 {/* ... */}）
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // 再去整行注释：去掉行首空白后以 // 开头
  out = out
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
  return out;
}

/** 抽出 `const NAME ... = [...]` 的数组字面量文本。
 *  注意不能直接 indexOf('[') —— 类型标注里就有方括号
 *  （`const SETTING_CATS: {...}[] = [`、`const SETTING_SEARCH_INDEX: SettingSearchItem[] = [`），
 *  必须先定位到赋值号 `=` 再取其后的第一个 `[`。这是本脚本第一版的真实 bug。 */
function extractArrayLiteral(source, name) {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) return null;
  const assign = source.indexOf('=', start);
  if (assign < 0) return null;
  const open = source.indexOf('[', assign);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** 解析静态索引条目 [{id,key,kw,sub?}] */
function parseStaticIndex(source) {
  const literal = extractArrayLiteral(source, 'SETTING_SEARCH_INDEX');
  if (!literal) return [];
  const items = [];
  const re = /\{\s*id:\s*'([^']+)'\s*,\s*key:\s*'([^']+)'\s*,\s*(sub:\s*'([^']+)'\s*,\s*)?kw:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(literal)) !== null) {
    items.push({
      id: m[1],
      key: m[2],
      sub: m[4] || null,
      kw: m[5]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean),
    });
  }
  return items;
}

/** 解析 SETTING_CATS [{id,labelKey}] */
function parseSettingCats(source) {
  const literal = extractArrayLiteral(source, 'SETTING_CATS');
  if (!literal) return [];
  const items = [];
  const re = /\{\s*id:\s*'([^']+)'\s*,\s*labelKey:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = re.exec(literal)) !== null) items.push({ id: m[1], labelKey: m[2] });
  return items;
}

/** 源码里出现过的所有 DOM 锚点 id。
 *  两种写法都要收：
 *   1. 字面量 `id="sec-xxx"`
 *   2. 间接写法 `<MediaApiConfigEditor sectionId="sec-tts" />` —— 该组件内部是 `<div id={sectionId}>`，
 *      最终渲染出的锚点同样是 sec-tts。只认字面量会把它误判成「孤儿条目」（第一版的真实误报）。
 *  另外排除 React 的 key/ref 等非 DOM 属性。 */
function collectDomAnchors(source) {
  const out = new Set();
  let m;
  const idRe = /\sid="([^"]+)"/g;
  while ((m = idRe.exec(source)) !== null) out.add(m[1]);
  const secRe = /\ssectionId="([^"]+)"/g;
  while ((m = secRe.exec(source)) !== null) out.add(m[1]);
  return out;
}

/** 源码里出现过的所有 catRefs.current['xxx'] = el 注册 */
function collectCatRefs(source) {
  const out = new Set();
  const re = /catRefs\.current\[['"]([^'"]+)['"]\]\s*=/g;
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

const staticIndex = parseStaticIndex(code);
const cats = parseSettingCats(code);
const domAnchors = collectDomAnchors(code);
const catRefs = collectCatRefs(code);

// v2.3.102 需求 3：7 类 nav 的**精确 id 集合**（顺序无关）。
// 为什么不能只断言 length===7：数个数抓不到「id 被整体改错」这类漂移 ——
// 例如把 cat-appearance 整体改名成 cat-look、其余 6 项不动，7 项 nav↔ref↔dom 对应关系全对 → 照样绿。
// 这条门是「搜到点不到」历史顽疾的唯一防线，必须锁死集合本身。
// 用 .sort() 让断言只锁**集合**、与**顺序**解耦（呈现顺序由设置页 JSX 与 SETTING_CATS 另行保证）。
const EXPECT_CATS = [
  'cat-general',
  'cat-appearance',
  'cat-chat',
  'cat-proactive',
  'cat-social',
  'cat-extensions',
  'cat-window',
];
function checkCatSet() {
  const actualIds = cats.map((c) => c.id).slice().sort().join(',');
  const expectIds = EXPECT_CATS.slice().sort().join(',');
  check(
    `SETTING_CATS id 集合精确匹配（实际 ${actualIds}）`,
    actualIds === expectIds,
    `期望 ${expectIds}\n        实际 ${actualIds}`
  );
}

console.log('设置搜索索引验证 (v2.3.97)');
console.log(`  解析到：静态索引 ${staticIndex.length} 条 / 分类 ${cats.length} 项 / DOM 锚点 ${domAnchors.size} 个`);

// ---------------------------------------------------------------------------
section('A0. 解析器自检（防止脚本本身失效而「假通过」）');
// 一个坏掉的解析器会让所有断言变成「0 条命中」然后靠其它宽松条件蒙混过关。
// 这里先确认解析器确实抓到了东西，再往下做。
{
  check(`静态索引解析到条目（${staticIndex.length} 条，应 > 40）`, staticIndex.length > 40);
  // v2.3.102 需求 3：分类由 8 类重分类为 7 类（cat-generation + cat-translation 合并为 cat-extensions）。
  // 先确认解析到 7 项（解析器自检），再锁死精确 id 集合（防「整体改名」漂移）。
  check(`SETTING_CATS 解析到分类（${cats.length} 项，应为 7）`, cats.length === 7);
  checkCatSet();
  check(`DOM 锚点解析成功（${domAnchors.size} 个，应 > 50）`, domAnchors.size > 50);
  check('去注释后仍能取到赋值号后的数组（解析器未被注释破坏）', extractArrayLiteral(code, 'SETTING_SEARCH_INDEX') !== null);
}

// ---------------------------------------------------------------------------
section('A1. 静态索引的每条 id 在源码里都有对应 DOM 锚点');
// 这是「搜得到点了没反应」的第一道门：索引里有、DOM 里没有 = 死条目。
{
  const orphans = staticIndex.filter((i) => !domAnchors.has(i.id));
  check(
    `静态索引无孤儿条目（${staticIndex.length} 条全部有 DOM 锚点）`,
    orphans.length === 0,
    orphans.length ? '孤儿: ' + orphans.map((o) => o.id).join(', ') : ''
  );
}

// ---------------------------------------------------------------------------
section('A2. 无条件渲染的条目确实是无条件渲染的');
// sec-glassbg 的教训：静态表无条件收录，但 DOM 里被 theme 守卫包着 → 12/14 主题下是死条目。
// 修法是「静态表不收 + 动态规则按存在性收录」，所以断言它不在静态表里。
{
  check(
    'sec-glassbg 不在静态索引中（改由动态规则⑥按 DOM 存在性收录）',
    !staticIndex.some((i) => i.id === 'sec-glassbg'),
    '仍在静态表里 → 非 glass/frost 主题下会变成死条目'
  );
  // v2.3.97：原先硬编码两主题的字面写法 `(theme === 'glass' || theme === 'frost') && (`，
  // 但液态玻璃加入后该守卫已扩容为三主题 → 断言误报。改为**通用匹配**：
  // 只要存在「theme 判断 && (」形式的条件渲染守卫即算通过，不再锁死具体主题列表。
  const glassGuard = /\(theme === '[a-z]+'(\s*\|\|\s*theme === '[a-z]+')+\)\s*&&\s*\(/.test(code);
  check('sec-glassbg 的 DOM 确实仍受 glass/frost 主题守卫（说明必须条件收录）', glassGuard);
}

// ---------------------------------------------------------------------------
section('A3. MutationObserver：存在 + 防抖 + 排除自身写 id 引起的回调');
// 这是缺口 A 的核心。三个子条件缺一不可：
//   ① 用 MutationObserver 监听条件区块的挂载/卸载；
//   ② 有防抖（否则用户打字时每个字符都重建全量索引，卡顿）；
//   ③ **不监听 attributes** —— 索引构建本身会写 el.id，若监听 attributes 会自触发死循环。
{
  const hasObserver = /new MutationObserver\(/.test(code);
  check('使用 MutationObserver 监听 DOM 变化', hasObserver);

  const debounceRe = /rebuildTimerRef\.current = window\.setTimeout\(\(\) => \{[\s\S]{0,200}?\}, (\d+)\)/;
  const dm = debounceRe.exec(code);
  const debounceMs = dm ? Number(dm[1]) : 0;
  check('重建有防抖（setTimeout 合并连续 mutation）', !!dm, dm ? `${debounceMs}ms` : '未找到防抖');
  check('防抖间隔合理（150–600ms）', debounceMs >= 150 && debounceMs <= 600, `实际 ${debounceMs}ms`);
  check(
    '防抖被正确清理（连续触发时 clearTimeout 旧的定时器）',
    /window\.clearTimeout\(rebuildTimerRef\.current\)/.test(code)
  );

  // 关键：observe 的配置里**不能有 attributes**（含 attributeFilter: ['id']）。
  // 否则 add() 里 `el.id = id` 会触发 observer → 重建 → 再写 id → 无限循环，页面卡死。
  const observeCalls = [...code.matchAll(/observer\.observe\(([\s\S]{0,200}?)\);/g)].map((m) => m[1]);
  check('存在 observer.observe 调用', observeCalls.length > 0);
  const obsCfg = observeCalls[0] || '';
  check(
    'observe 配置排除了 attributes（自身写 el.id 不会触发回调 → 无死循环）',
    !/attributes\s*:\s*true/.test(obsCfg),
    obsCfg.replace(/\s+/g, ' ').slice(0, 120)
  );
  check('observe 配置含 childList + subtree（条件区块挂载/卸载）', /childList\s*:\s*true/.test(obsCfg) && /subtree\s*:\s*true/.test(obsCfg));

  // 双保险：内容指纹。没它，一旦 childList 因重渲染产生噪声就会 setState → 再触发 → 自激循环。
  check('有内容指纹兜底（内容未变则不 setSearchIndex，掐断自激循环）', /indexSigRef\.current = sig/.test(code) && /if \(sig === indexSigRef\.current\) return;/.test(code));

  // 旧的依赖数组方案不能单独存在（它就是漏洞根因）
  const depArrayOnly = /}, \[lang, draftReady, onlyModels\]\);/.test(code);
  check('索引 effect 不再只依赖 [lang, draftReady, onlyModels]（那正是漏洞根因）', !depArrayOnly, '仍存在只靠该依赖数组的 effect');
}

// ---------------------------------------------------------------------------
section('A4. 动态索引规则 ≥ 5 条（含 SelectMenu 规则⑤）');
{
  const prefixes = [...code.matchAll(/'(set-[a-z]+)'/g)].map((m) => m[1]);
  const uniq = [...new Set(prefixes)].sort();
  check(`动态索引规则 ≥ 5 条（实际 ${uniq.length} 条）`, uniq.length >= 5, uniq.join(', '));
  check("含 SelectMenu 规则 '.select-menu-trigger'（缺口 C）", /querySelectorAll<HTMLElement>\('\.select-menu-trigger'\)/.test(code));
  check('SelectMenu 条目前缀为 set-sel', uniq.includes('set-sel'));
  check("SelectMenu 专用取名函数 nameOfSelect 存在", /const nameOfSelect = /.test(code));
  check("含分区标题规则 '.section-title[id]'（缺口 B 根治点）", /querySelectorAll<HTMLElement>\('\.section-title\[id\]'\)/.test(code));
}

// ---------------------------------------------------------------------------
section('B. 静态条目按 DOM 存在性过滤 + 跳转失败有可见提示');
{
  check(
    '静态条目按 document.getElementById 存在性过滤（条件区块不再产生死条目）',
    /SETTING_SEARCH_INDEX\.filter\([\s\S]{0,160}?document\.getElementById\(item\.id\)/.test(code)
  );
  check(
    '二级页条目（带 sub）无条件保留（它们的锚点要等切页后才存在）',
    /!!item\.sub \|\| document\.getElementById/.test(code)
  );
  check('找不到目标时调用 showToast 给出可见提示（不再静默失败）', /showToast\(t\('settings\.searchTargetMissing'\)/.test(code));
  check('提示使用 error 样式（红色，明显可辨）', /showToast\(t\('settings\.searchTargetMissing'\),\s*\{\s*error:\s*true\s*\}\)/.test(code));
}

// ---------------------------------------------------------------------------
section('D. goToSetting 两个分支都有 retry（缺口 D 回归门）');
{
  const fnStart = code.indexOf('const goToSetting = (id: string');
  check('goToSetting 函数存在', fnStart > 0);
  const body = fnStart > 0 ? code.slice(fnStart, fnStart + 2200) : '';
  // retry 必须提到 if/else 之外 —— 旧代码是 if (sub) {...retry...} else { jump(); }
  const retryIdx = body.indexOf('const retry = () => {');
  const jumpIdx = body.indexOf('if (!jump()) {');
  check('存在 retry 轮询逻辑', retryIdx > 0);
  check('retry 由「首次 jump 失败」统一触发（不分主页面/二级页）', jumpIdx > 0 && retryIdx > jumpIdx);
  check('retry 有次数上限（不会无限轮询）', /\+\+tries >= \d+/.test(body), '未找到重试上限');
  check('旧的双分支结构已移除（不再有 else { jump(); } 裸调用）', !/else\s*\{\s*jump\(\);\s*\}/.test(body));
  check('二级页仍会先 setSub 再等待渲染', /setSub\(sub\)/.test(body));
  // retry 上限必须足够覆盖 React 渲染延迟（>=20 次 ×20ms = 400ms）
  const tries = body.match(/\+\+tries >= (\d+)/);
  check('retry 上限足够（≥20 次 ≈ 400ms，覆盖慢机器）', tries && Number(tries[1]) >= 20, tries ? `实际 ${tries[1]} 次` : '未找到');
}

// ---------------------------------------------------------------------------
section('E. 静态表补齐关键锚点');
{
  const mustHave = [
    ['sec-anim-control', '动效分组（仅自定义档渲染，绝不能漏）'],
    ['sec-mediastub', '生成与扩展的跳转卡'],
    ['sec-proactive-engine', '主动消息机制'],
  ];
  for (const [id, why] of mustHave) {
    check(`静态表包含 ${id} —— ${why}`, staticIndex.some((i) => i.id === id));
  }
  // cat-models 不该有导航入口
  check('cat-models 不在静态索引中（它是二级页容器，非可跳转分类）', !staticIndex.some((i) => i.id === 'cat-models'));
  // 每条都要有关键词，否则模糊搜索排不上去
  const noKw = staticIndex.filter((i) => i.kw.length === 0);
  check(`每条静态条目都有关键词（${staticIndex.length} 条检查）`, noKw.length === 0, noKw.map((i) => i.id).join(', '));
}

// ---------------------------------------------------------------------------
section('F. 弹窗内控件可被索引（缺口 F 取舍）');
{
  // 取舍：root 从 panelRef.current 扩展为「panel + 本设置页内的 .modal-mask」，
  // 而不是 document.body（那会扫进聊天页等无关控件）。这里断言这个方案在位。
  check(
    '扫描根扩展到弹窗（closest(.main-pane) + .modal-mask）',
    /closest\('\.main-pane'\)/.test(code) && /querySelectorAll<HTMLElement>\('\.modal-mask'\)/.test(code)
  );
  check('明确不用 document.body 作扫描根（会扫进无关页面）', !/const root = document\.body/.test(code));
}

// ---------------------------------------------------------------------------
section('G. 分类跳转：SETTING_CATS 逐条对应 ref 注册 + DOM 锚点（回归门）');
// 这是防止「将来把功能搬到别处又漏配导航」的那道门。
{
  // v2.3.102 需求 3：锁死精确 id 集合（不只数个数），防「id 整体改错但全站一致改错」的漂移。
  checkCatSet();
  let allOk = true;
  const report = [];
  for (const c of cats) {
    const hasRef = catRefs.has(c.id);
    const hasDom = domAnchors.has(c.id);
    const ok = hasRef && hasDom;
    if (!ok) allOk = false;
    report.push(
      `${c.id}: ref=${hasRef ? 'Y' : 'N'} dom=${hasDom ? 'Y' : 'N'}${ok ? '' : ' <<<'}`
    );
  }
  console.log('        ' + report.join('\n        '));
  check('7 个分类的 ref 注册与 DOM 锚点逐条对应（无失效、无漏配）', allOk);

  // 反向：catRefs 里不该有不在 SETTING_CATS 的项（旧的多余 cat-models 注册）
  const extraRefs = [...catRefs].filter((r) => !cats.some((c) => c.id === r));
  check(
    '无多余 catRefs 注册（旧代码多注册了一个不可达的 cat-models）',
    extraRefs.length === 0,
    extraRefs.length ? '多余: ' + extraRefs.join(', ') : ''
  );
}

// ---------------------------------------------------------------------------
section('H. scrollToCat 无不可达分支');
{
  const fnStart = code.indexOf('const scrollToCat = (id: string)');
  const body = fnStart > 0 ? code.slice(fnStart, fnStart + 800) : '';
  check('scrollToCat 函数存在', fnStart > 0);
  check(
    "不再有不可达的 `if (id === 'cat-models')` 分支",
    !/if \(id === 'cat-models'\)/.test(body),
    '仍有该分支；SETTING_CATS 已无 cat-models，永不可达'
  );
  check('scrollToCat 仍会 setActiveCat（左侧高亮同步）', /setActiveCat\(id\)/.test(body));
  check('scrollToCat 仍会 scrollIntoView（真正滚动到该分类）', /scrollIntoView/.test(body));
  // onPanelScroll 也要跟着正常
  const scrollFn = code.indexOf('const onPanelScroll = () => {');
  const scrollBody = scrollFn > 0 ? code.slice(scrollFn, scrollFn + 700) : '';
  check('onPanelScroll 依据 SETTING_CATS 计算当前分类', /SETTING_CATS\[0\]\.id/.test(scrollBody) && /SETTING_CATS/.test(body));
}

// ---------------------------------------------------------------------------
section('I. 索引条目结构对外不变（多处依赖，硬性约束）');
{
  check('SettingSearchItem 类型仍是 {id,key,kw,sub?}（未改对外结构）', /type SettingSearchItem = \{ id: string; key: string; kw: string\[\]; sub\?: 'models' \| 'font' \| 'self' \};/.test(code));
  check('searchIndex 仍是 SettingSearchItem[]', /useState<SettingSearchItem\[\]>\(SETTING_SEARCH_INDEX\)/.test(code));
  check('候选仍走 suggestWithCount + MAX_SUGGESTIONS（最多 5 条，用户铁律）', /suggestWithCount\(searchQ, searchIndex/.test(code) && /MAX_SUGGESTIONS\)/.test(code));
  check('按场景缓存 dynIndexCache 结构保留（models/main 两桶）', /dynIndexCache\.current\[scene\] = dyn/.test(code));
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 条断言）`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');