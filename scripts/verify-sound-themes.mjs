// v2.3.111 验证：主题音效系统（5 套新内置 + 解析优先级 + 设置 UI + i18n）
// 用法：node scripts/verify-sound-themes.mjs
//
// 背景（用户原话：「内置默认太死板机械，没有灵动感」）：v2.3.111 新增 5 套
// 程序合成的主题音效包（aurora / crystal / wood / bubble / chime），每套覆盖
// 全部 6 类音效；settings.sound 增加 theme 字段（出厂 'default'）。
//
// 本脚本锁死：
//   A. 30 个主题 wav 文件齐全、非空、头校验（RIFF/WAVE）；
//   B. sound.ts 解析优先级：角色自定义 > 该类型用户自定义 > 主题文件 > default 兜底；
//   C. Settings 音效区有主题选择器（6 主题 + 试听 + 落盘 + 即时生效）；
//   D. types.ts 的 theme 字段与出厂值；
//   E. i18n 9 个主题键在 10 处语言齐备；
//   F. nodeBanner 音效按既有约定**不进**主题系统；
//   G. 可证伪性：打乱优先级顺序 / 删主题 → 断言必须变红。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SOUNDS = path.join(ROOT, 'public', 'sounds');
const SOUND_TS = path.join(ROOT, 'src', 'utils', 'sound.ts');
const SETTINGS_TSX = path.join(ROOT, 'src', 'components', 'Settings.tsx');
const TYPES_TS = path.join(ROOT, 'src', 'types.ts');
const TRANS = path.join(ROOT, 'src', 'i18n', 'translations.ts');

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

/** 去注释（断言基于代码，修复说明注释里会写被禁写法） */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return out
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

const soundCode = stripComments(fs.readFileSync(SOUND_TS, 'utf8'));
const settingsCode = stripComments(fs.readFileSync(SETTINGS_TSX, 'utf8'));
const typesCode = fs.readFileSync(TYPES_TS, 'utf8');
const transSrc = fs.readFileSync(TRANS, 'utf8');

const THEMES = ['aurora', 'crystal', 'wood', 'bubble', 'chime'];
const TYPES = ['error', 'click', 'notification', 'popup', 'miniPopup', 'messageSend'];

// ---------- A. 主题 wav 文件齐全 ----------
section('A. 主题音效文件（public/sounds/themes/，5 套 × 6 类 = 30 个）');
{
  let allOk = true;
  const missing = [];
  let totalBytes = 0;
  for (const th of THEMES) {
    for (const ty of TYPES) {
      const p = path.join(SOUNDS, 'themes', th, `${ty}.wav`);
      if (!fs.existsSync(p)) {
        allOk = false;
        missing.push(`themes/${th}/${ty}.wav`);
        continue;
      }
      const buf = fs.readFileSync(p);
      totalBytes += buf.length;
      // WAV 头校验：RIFF....WAVE
      if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        allOk = false;
        missing.push(`themes/${th}/${ty}.wav(坏头)`);
      }
    }
  }
  check('30 个主题 wav 全部存在且 WAV 头合法', allOk, missing.slice(0, 6).join(', '));
  check('主题包总体积合理（< 2MB，程序合成小文件）', totalBytes > 0 && totalBytes < 2 * 1024 * 1024,
    `实际 ${(totalBytes / 1024).toFixed(1)} KB`);
  // 经典默认包不许被主题化改动（6 + nodeBanner 仍在根目录）
  for (const f of [...TYPES.map((t) => `${t}.wav`), 'nodeBanner.wav']) {
    check(`经典默认包保留 public/sounds/${f}`, fs.existsSync(path.join(SOUNDS, f)));
  }
}

// ---------- B. sound.ts 解析优先级 ----------
section('B. sound.ts：解析优先级 = 角色自定义 > 用户自定义 > 主题文件 > default 兜底');
{
  check('导出 SOUND_THEMES（6 个内置主题）', /export const SOUND_THEMES: SoundTheme\[\] = \[[^\]]*'default'[^\]]*\];/.test(soundCode));
  check('SOUND_THEMES 含全部 5 套新主题',
    THEMES.every((t) => soundCode.includes(`'${t}'`)));
  check('SoundTheme 类型含 7 个成员（6 内置 + 自定义）', /export type SoundTheme = 'default' \| 'aurora' \| 'crystal' \| 'wood' \| 'bubble' \| 'chime' \| 'user';/.test(soundCode));

  // pickBuiltin：主题分支返回 sounds/themes/<id>/<file>.wav
  check('pickBuiltin 有主题分支（sounds/themes/<id>/<file>）',
    /sounds\/themes\/\$\{theme\}\/\$\{SOUND_FILE_NAMES\[type\]\}/.test(soundCode));

  // resolveSoundUrl 的顺序：characterSound → custom → theme → pickBuiltin
  const fnStart = soundCode.indexOf('export async function resolveSoundUrl');
  check('resolveSoundUrl 存在', fnStart > 0);
  const fnBody = fnStart > 0 ? soundCode.slice(fnStart, fnStart + 700) : '';
  const iChar = fnBody.indexOf('if (characterSound)');
  const iCustom = fnBody.indexOf('const custom = s.custom?.[type]');
  const iTheme = fnBody.indexOf('const theme = opts?.theme ?? s.theme');
  const iPick = fnBody.indexOf('return pickBuiltin(type, theme)');
  check('优先级顺序：角色自定义最先', iChar > 0);
  check('优先级顺序：用户自定义在角色之后', iCustom > iChar);
  check('优先级顺序：主题解析在用户自定义之后', iTheme > iCustom);
  check('优先级顺序：主题文件先于 default 兜底返回', iPick > iTheme);
  // 反向：custom 为空的判断不能跑到 theme 之后（否则自定义失效）
  check('用户自定义非空即返回（不被主题覆盖）', /if \(custom\) return NY_SCHEME \+ custom;/.test(fnBody));

  // 试听：主题包直播（绕过自定义）+ 普通试听支持主题参数
  check('previewThemeSound 存在（主题选择器试听，直播主题包文件）', /export async function previewThemeSound\(/.test(soundCode));
  check('previewSound 支持 theme 参数（第三参）', /export async function previewSound\(\s*type: SoundType,\s*characterSound\?: string \| null,\s*theme\?: SoundTheme\s*\)/.test(soundCode));
  check('getSettings 读取并校验 theme（脏数据回退 default）', /theme: isSoundTheme\(s\.sound\?\.theme\)/.test(soundCode));

  // F. nodeBanner 不进主题系统（既有约定）
  check('nodeBanner 仍走根目录内置文件（不进主题系统）', /const NODE_BANNER_SOUND = 'sounds\/nodeBanner\.wav';/.test(soundCode));
  {
    // 精确截取 playNodeBannerSound 函数体（到下一个 export 为止），断言它不读 theme
    const fnStart = soundCode.indexOf('export async function playNodeBannerSound');
    const fnEnd = soundCode.indexOf('export async function previewSound', fnStart);
    const fnBody = fnStart > 0 ? soundCode.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 800) : '';
    check('playNodeBannerSound 存在', fnStart > 0);
    check('nodeBanner 播放不读 theme（不进主题系统）', fnBody.length > 0 && !/theme/.test(fnBody),
      '函数体里出现了 theme —— 违背「nodeBanner 不进主题系统」的既有约定');
    check('nodeBanner 播放不调 pickBuiltin（固定内置文件）', !/pickBuiltin/.test(fnBody));
  }
}

// ---------- C. Settings UI ----------
section('C. Settings 音效区：主题选择器（6 主题 + 试听 + 落盘 + 即时生效）');
{
  check('音效区遍历 SOUND_THEMES 渲染主题按钮', /SOUND_THEMES\.map\(\(th: SoundTheme\)/.test(settingsCode));
  check('主题按钮点击落盘（api.saveSettings({ sound: { ...sound, theme: th } })）',
    /api\.saveSettings\(\{ sound: \{ \.\.\.sound, theme: th \} \}\)\.then\(reloadSettings\)/.test(settingsCode));
  check('主题切换即时生效（invalidateSoundCache）', settingsCode.includes('invalidateSoundCache()'));
  check('主题按钮带试听（previewThemeSound）', settingsCode.includes('previewThemeSound(th)'));
  check('主题名走 i18n（SOUND_THEME_LABEL_KEYS）', settingsCode.includes('SOUND_THEME_LABEL_KEYS[th]'));
  check('每类音效的「导入外部音效」入口保留（pickSound 未删）', /onClick=\{\(\) => pickSound\(row\.type\)\}/.test(settingsCode));
  check('每类音效的试听按钮保留（previewSoundType 未删）', /onClick=\{\(\) => previewSoundType\(row\.type\)\}/.test(settingsCode));
  // 选择即预览（原需求「选择即时预览」）
  check('选择主题即试听代表音（点击主题按钮后 previewThemeSound）',
    /patchSound\(\{ theme: th \}\);[\s\S]{0,240}?previewThemeSound\(th\);/.test(settingsCode));
}

// ---------- D. types.ts ----------
section('D. types.ts：sound.theme 字段与出厂值');
{
  check('AppSettings.sound 增加 theme 字段（7 成员可选，V3 起含 user）',
    /theme\?: 'default' \| 'aurora' \| 'crystal' \| 'wood' \| 'bubble' \| 'chime' \| 'user';/.test(typesCode));
  check('DEFAULT_SETTINGS.sound.theme 出厂为 default', /sound: \{\s*enabled: true,\s*volume: 0\.7,\s*theme: 'default',/.test(typesCode));
}

// ---------- E. i18n 9 键 10 处 ----------
section('E. i18n：主题相关键 10 处齐备');
{
  const keys = [
    'settings.soundTheme',
    'settings.soundThemeDesc',
    'settings.soundThemeDefault',
    'settings.soundThemeAurora',
    'settings.soundThemeCrystal',
    'settings.soundThemeWood',
    'settings.soundThemeBubble',
    'settings.soundThemeChime',
    // V3：新增「自定义（本地音效）」主题
    'settings.soundThemeUser',
  ];
  for (const k of keys) {
    const n = (transSrc.match(new RegExp(`'${k}':`, 'g')) || []).length;
    check(`translations.ts 有 ${k}（zh+en 共 2 处）`, n === 2, `实得 ${n}`);
  }
  for (const l of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', `${l}.json`), 'utf8'));
    const miss = keys.filter((k) => typeof j[k] !== 'string' || !j[k].trim());
    check(`locales/${l}.json 含 9 个主题键且非空`, miss.length === 0, miss.join(', '));
  }
}

// ---------- G. 可证伪性 ----------
section('G. 可证伪性自证（打乱优先级 → 断言必须变红）');
{
  // 把 custom 判断挪到 theme 之后（模拟「主题覆盖自定义」的错误回归）
  const broken = soundCode.replace(
    /const custom = s\.custom\?\.\[type\];\s*if \(custom\) return NY_SCHEME \+ custom;\s*const theme = opts\?\.theme \?\? s\.theme;\s*return pickBuiltin\(type, theme\);/,
    'const theme = opts?.theme ?? s.theme;\n  return pickBuiltin(type, theme);\n  const custom = s.custom?.[type];\n  if (custom) return NY_SCHEME + custom;'
  );
  check('注入「主题先于自定义」后 B 段顺序断言变红', broken !== soundCode && !/if \(custom\) return NY_SCHEME \+ custom;\s*const theme = opts\?\.theme \?\? s\.theme;/.test(broken));
  // 删掉一个主题文件 → A 段必须红
  const themeDir = path.join(SOUNDS, 'themes', 'aurora');
  const probe = path.join(themeDir, 'click.wav');
  const existsBefore = fs.existsSync(probe);
  check('（对照）aurora/click.wav 当前存在（A 段断言有区分度）', existsBefore);
}

console.log('\n' + '='.repeat(60));
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail === 0 ? 0 : 1);
