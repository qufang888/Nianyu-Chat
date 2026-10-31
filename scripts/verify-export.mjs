// ============================================================================
// 导出功能 + 桌宠滚轮缩放 验证
// 用法：node scripts/verify-export.mjs
//
// 把「不可回退的结构契约」固化成断言：
//   A. 桌宠滚轮缩放（dc:set-scale IPC + 渲染层 onWheel + 0.6~1.6 钳制）
//   B. 导出工具模块（5 个 build* 函数 + 酒馆兼容结构）
//   C. 5 处导出按钮（角色卡 / 世界书 / 规则单条 / 规则全部 / 记忆 / 聊天记录）
//   D. 10 处 i18n 导出键齐全
//
// 可证伪性：
//   · 删掉 dc:set-scale → A 段红
//   · 删掉 onCharacterWheel / onWheel → A 段红
//   · 删掉任一 build* 函数 → B 段红
//   · 删掉任一导出按钮 → C 段红
//   · 漏改某语言 → D 段红
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : ''));
  }
}
const read = (p) => {
  try {
    return fs.readFileSync(path.join(ROOT, p), 'utf-8');
  } catch {
    return '';
  }
};
const section = (s) => console.log('\n===== ' + s + ' =====');

// ---------- 读取源文件 ----------
const dcMain = read('electron/desktopCharacter.ts');
const dcRender = read('src/character/CharacterApp.tsx');
const ipcTs = read('src/ipc.ts');
const preload = read('electron/preload.ts');
const exportTs = read('src/utils/export.ts');
const roleEditor = read('src/components/RoleEditor.tsx');
const wbEditor = read('src/components/WorldBookEditor.tsx');
const ruleEditor = read('src/components/RuleEditor.tsx');
const library = read('src/components/Library.tsx');
const memPanel = read('src/components/MemoryPanel.tsx');
const chatWin = read('src/components/ChatWindow.tsx');
const trans = read('src/i18n/translations.ts');

section('A. 桌宠滚轮缩放');
check('desktopCharacter.ts 注册 dc:set-scale IPC', dcMain.includes("ipcMain.on('dc:set-scale'"));
check('dc:set-scale 持久化 desktopCharacters 并落盘', dcMain.includes('saveSettings({ desktopCharacters: next })') && dcMain.includes('sendState()'));
check('dc:set-scale 钳制 0.6~1.6', /Math\.max\(0\.6,\s*Math\.min\(1\.6/.test(dcMain));
check('CharacterApp.tsx 绑定 onWheel 到角色本体', dcRender.includes('onWheel={onCharacterWheel}'));
check('CharacterApp.tsx 定义 onCharacterWheel 处理器', dcRender.includes('const onCharacterWheel ='));
check('onCharacterWheel 钳制 0.6~1.6 并四舍五入到两位小数', dcRender.includes('0.6') && dcRender.includes('1.6') && dcRender.includes('Math.round'));
check('onCharacterWheel 调用 api.dcSetScale', dcRender.includes('api.dcSetScale('));
check('ipc.ts 声明 dcSetScale 接口', ipcTs.includes('dcSetScale: (id: string, scale: number)'));
check('ipc.ts 转发 dcSetScale', ipcTs.includes('dcSetScale: (id, scale) => raw.dcSetScale(id, scale)'));
check('preload.ts 声明 dcSetScale', preload.includes('dcSetScale: (id: string, scale: number)'));
check('preload.ts 映射 dcSetScale → ipcRenderer.send(\'dc:set-scale\')', preload.includes("ipcRenderer.send('dc:set-scale', id, scale)"));

section('B. 导出工具模块（src/utils/export.ts）');
check('export.ts 存在', exportTs.length > 0);
check('export.ts 导出 buildCharacterCard', exportTs.includes('export function buildCharacterCard'));
check('export.ts 导出 buildWorldBook', exportTs.includes('export function buildWorldBook'));
check('export.ts 导出 buildRegexScripts', exportTs.includes('export function buildRegexScripts'));
check('export.ts 导出 buildMemories', exportTs.includes('export function buildMemories'));
check('export.ts 导出 buildChatExport', exportTs.includes('export function buildChatExport'));
check('角色卡映射为 SillyTavern V3（spec = chara_card_v3）', exportTs.includes("spec: 'chara_card_v3'"));
check('世界书映射为 Lorebook（scanDepth / tokenBudget）', exportTs.includes('tokenBudget') && exportTs.includes('entries'));
check('规则映射为 Regex Scripts（script 留空 + replaceString 写内容）', exportTs.includes("script: ''") && exportTs.includes('replaceString: r.content'));
check('聊天记录映射为 ST 现代数组（name/role/content）', exportTs.includes("role: 'assistant'") || exportTs.includes("role: 'user'"));

section('C. 5 类导出按钮');
check('RoleEditor 调用 buildCharacterCard + 导出键', roleEditor.includes('buildCharacterCard') && roleEditor.includes("t('export.characterCard')"));
check('WorldBookEditor 调用 buildWorldBook + 导出键', wbEditor.includes('buildWorldBook') && wbEditor.includes("t('export.worldBook')"));
check('RuleEditor 调用 buildRegexScripts + 导出键（单条）', ruleEditor.includes('buildRegexScripts') && ruleEditor.includes("t('export.rule')"));
check('Library 调用 buildRegexScripts + 导出键（全部）', library.includes('buildRegexScripts') && library.includes("t('export.allRules')"));
check('MemoryPanel 调用 buildMemories + 导出键', memPanel.includes('buildMemories') && memPanel.includes("t('export.memories')"));
check('ChatWindow 调用 buildChatExport + 导出键', chatWin.includes('buildChatExport') && chatWin.includes("t('export.chat')"));
check('各导出按钮均复用 api.saveTextFile', roleEditor.includes('saveTextFile') && wbEditor.includes('saveTextFile') && ruleEditor.includes('saveTextFile') && library.includes('saveTextFile') && memPanel.includes('saveTextFile') && chatWin.includes('saveTextFile'));

section('D. 10 处 i18n 导出键齐全');
const exportKeys = ['export.allRules', 'export.characterCard', 'export.chat', 'export.exported', 'export.memories', 'export.rule', 'export.worldBook'];
{
  const zhBlock = trans.slice(trans.indexOf("  zh: {"), trans.indexOf("  en: {"));
  const enBlock = trans.slice(trans.indexOf("  en: {"), trans.indexOf("  de: deDict"));
  const zhOk = exportKeys.every((k) => zhBlock.includes("'" + k + "':"));
  const enOk = exportKeys.every((k) => enBlock.includes("'" + k + "':"));
  check('translations.ts zh 段 7 个导出键齐全', zhOk);
  check('translations.ts en 段 7 个导出键齐全', enOk);
  const langs = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
  let allLocaleOk = true;
  const miss = [];
  for (const l of langs) {
    const p = path.join(ROOT, 'src/i18n/locales', l + '.json');
    let d = {};
    try {
      d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
    for (const k of exportKeys) {
      if (!(k in d) || typeof d[k] !== 'string' || d[k].trim() === '') {
        allLocaleOk = false;
        miss.push(l + ':' + k);
      }
    }
  }
  check('8 个 locale 导出键齐全且非空', allLocaleOk, miss.slice(0, 6).join(', '));
}

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
