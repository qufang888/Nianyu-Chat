// 导出功能（角色卡/聊天记录/世界书/规则/记忆）的 10 语言文案同步。
// 注入锚点：'characters.menuHide'（在 translations.ts 出现 2 次 = zh + en；在 8 个 locale 各出现 1 次）。
// 仅按行插入（不 json/ast 重写），保持最小 diff。注入后断言「键数 / 读回一致」。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ANCHOR = 'characters.menuHide';

// 7 个导出键（无占位符）。zh / zh-Hant 为原生译文；其余 8 语言先用英文兜底（避免非中英用户裸露键名，
// 导出按钮属低频功能，英文兜底可接受；后续可逐语言补译）。
const T = {
  zh: {
    'export.allRules': '导出全部规则',
    'export.characterCard': '导出角色卡',
    'export.chat': '导出聊天记录',
    'export.exported': '已导出',
    'export.memories': '导出记忆',
    'export.rule': '导出规则',
    'export.worldBook': '导出世界书',
  },
  en: {
    'export.allRules': 'Export all rules',
    'export.characterCard': 'Export character card',
    'export.chat': 'Export chat history',
    'export.exported': 'Exported',
    'export.memories': 'Export memories',
    'export.rule': 'Export rule',
    'export.worldBook': 'Export world book',
  },
  de: null,
  es: null,
  fr: null,
  ja: null,
  ko: null,
  pt: null,
  ru: null,
  'zh-Hant': {
    'export.allRules': '匯出全部規則',
    'export.characterCard': '匯出角色卡',
    'export.chat': '匯出聊天記錄',
    'export.exported': '已匯出',
    'export.memories': '匯出記憶',
    'export.rule': '匯出規則',
    'export.worldBook': '匯出世界書',
  },
};
for (const l of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru']) T[l] = T.en;

function jsStr(s) {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function insertAfter(lines, anchor, newLines, nth) {
  const out = [];
  let seen = 0;
  let hit = false;
  for (const line of lines) {
    out.push(line);
    if (line.includes(anchor)) {
      seen++;
      if (seen === nth && !hit) {
        out.push(...newLines);
        hit = true;
      }
    }
  }
  return [out, hit];
}

// ---------- translations.ts（zh + en 两段）----------
const PT = path.join(ROOT, 'src', 'i18n', 'translations.ts');
let tText = fs.readFileSync(PT, 'utf8');
if (tText.includes("'export.exported':")) {
  console.log('  SKIP translations.ts 已存在');
} else {
  const nl = tText.includes('\r\n') ? '\r\n' : '\n';
  const lines = tText.split(nl);
  const zhLines = Object.keys(T.zh)
    .sort()
    .map((k) => "    '" + k + "': " + jsStr(T.zh[k]) + ',');
  const enLines = Object.keys(T.en)
    .sort()
    .map((k) => "    '" + k + "': " + jsStr(T.en[k]) + ',');
  let out, hit1;
  [out, hit1] = insertAfter(lines, "'" + ANCHOR + "':", zhLines, 1);
  if (!hit1) throw new Error('translations.ts 找不到 zh 段锚点');
  let hit2;
  [out, hit2] = insertAfter(out, "'" + ANCHOR + "':", enLines, 2);
  if (!hit2) throw new Error('translations.ts 找不到 en 段锚点');
  fs.writeFileSync(PT, out.join(nl) + nl);
  const back = fs.readFileSync(PT, 'utf8');
  for (const k of Object.keys(T.zh)) {
    const n = (back.match(new RegExp("'" + k + "':", 'g')) || []).length;
    if (n !== 2) throw new Error('translations.ts 里 ' + k + ' 出现 ' + n + ' 次（应为 2）');
  }
  console.log('  OK  translations.ts  zh + en  各 ' + Object.keys(T.zh).length + ' 键');
}

// ---------- 8 个 locale JSON ----------
for (const lang of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
  const p = path.join(ROOT, 'src', 'i18n', 'locales', lang + '.json');
  let t2 = fs.readFileSync(p, 'utf8');
  if (t2.includes('"export.exported":')) {
    console.log('  SKIP ' + lang + '.json 已存在');
    continue;
  }
  const nl = t2.includes('\r\n') ? '\r\n' : '\n';
  const lines = t2.split(nl);
  const newLines = Object.keys(T[lang])
    .sort()
    .map((k) => ' "' + k + '": ' + JSON.stringify(T[lang][k]) + ',');
  let out, hit;
  [out, hit] = insertAfter(lines, '"' + ANCHOR + '":', newLines, 1);
  if (!hit) throw new Error(lang + '.json 找不到锚点');
  fs.writeFileSync(p, out.join(nl) + nl);
  const back = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of Object.keys(T[lang])) {
    if (back[k] !== T[lang][k]) throw new Error(lang + '.json 的 ' + k + ' 读回不一致');
  }
  console.log('  OK  ' + lang + '.json  ' + Object.keys(T[lang]).length + ' 键');
}

console.log('== 导出 i18n 同步完成 ==');
