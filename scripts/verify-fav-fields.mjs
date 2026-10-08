// v2.3.101 需求 1 验证：「最喜爱的人物」新增 6 个资料字段（职业/性格/爱好/国籍/学历/菜）
// 用法：node scripts/verify-fav-fields.mjs
//
// 可证伪性对照（每条都必须能失败）：
//   NY_DROP_FIELD=1  node scripts/verify-fav-fields.mjs   应当失败（从 types.ts 删掉 favoriteFood）
//
// 需求原文：「最喜爱的人物板块新增职业、性格、爱好、国籍、学历，还有最喜欢吃的菜栏目。
//            可以自己在板块编辑界面填入，保存后在板块内展示。」

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FORCE = { dropField: process.env.NY_DROP_FIELD === '1' };

let pass = 0,
  fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// 字段：草稿键名 ↔ settings 键名 ↔ i18n 前缀
const FIELDS = [
  { draft: 'occupation', setting: 'favoriteOccupation', i18n: 'Occupation' },
  { draft: 'personality', setting: 'favoritePersonality', i18n: 'Personality' },
  { draft: 'hobby', setting: 'favoriteHobby', i18n: 'Hobby' },
  { draft: 'nationality', setting: 'favoriteNationality', i18n: 'Nationality' },
  { draft: 'education', setting: 'favoriteEducation', i18n: 'Education' },
  { draft: 'food', setting: 'favoriteFood', i18n: 'Food' },
];

section('1. types.ts 声明与默认值');
{
  let types = read('src/types.ts');
  if (FORCE.dropField) {
    types = types.replace(/favoriteFood\??:[^\n]*\n/g, '');
    console.log('  (NY_DROP_FIELD=1 → 已从 types.ts 删掉 favoriteFood)');
  }
  for (const f of FIELDS) {
    check(`types.ts 声明 ${f.setting}`, new RegExp(`${f.setting}\\?:\\s*string`).test(types));
  }
  for (const f of FIELDS) {
    check(`DEFAULT_SETTINGS 含 ${f.setting}: ''`, new RegExp(`${f.setting}:\\s*''`).test(types));
  }
}

section('2. StatsView：草稿/保存/回填/清空/编辑界面渲染');
{
  const s = read('src/components/StatsView.tsx');
  check('FavDraft 接口含 6 个字段', FIELDS.every((f) => new RegExp(`\\b${f.draft}:\\s*string`).test(s)));
  check("EMPTY_FAV_DRAFT 含 6 个 ''", FIELDS.every((f) => new RegExp(`\\b${f.draft}:\\s*''`).test(s)));
  check('FAV_FIELD_MAXLEN 已定义（单字段上限）', /const FAV_FIELD_MAXLEN\s*=\s*\d+/.test(s));
  check('FavFieldKey 联合类型含全部 6 键', FIELDS.every((f) => new RegExp(`'${f.draft}'`).test(s)));
  check('保存时写回 6 个 settings 字段（trim 后）', FIELDS.every((f) => new RegExp(`${f.setting}:\\s*favDraft\\.${f.draft}\\.trim\\(\\)`).test(s)));
  check('打开编辑器时回填 6 个字段', FIELDS.every((f) => new RegExp(`${f.draft}:\\s*settings\\?\\.${f.setting}`).test(s)));
  check('编辑界面渲染 .stats-fav-editor-block 块', /className="stats-fav-editor-block"/.test(s));
  check('展示区 .stats-fav-info-list 仅在 infoItems.length>0 时渲染（不占位）', /infoItems\.length\s*>\s*0[\s\S]{0,80}?stats-fav-info-list/.test(s));
  check('有统一变更回调 onFieldChange', /onFieldChange/.test(s));
}

section('3. i18n 10 处：6 字段的 Label + Ph 共 12 键');
{
  const trans = read('src/i18n/translations.ts');
  for (const f of FIELDS) {
    const key = `stats.fav${f.i18n}Label`;
    const key2 = `stats.fav${f.i18n}Ph`;
    const n = (trans.match(new RegExp(`'${key}':`, 'g')) || []).length;
    const n2 = (trans.match(new RegExp(`'${key2}':`, 'g')) || []).length;
    check(`translations.ts 有 ${key}（zh+en 共 2 处）`, n === 2, `实得 ${n}`);
    check(`translations.ts 有 ${key2}（zh+en 共 2 处）`, n2 === 2, `实得 ${n2}`);
  }
  const LANGS = ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'];
  for (const lang of LANGS) {
    const j = JSON.parse(read(`src/i18n/locales/${lang}.json`));
    let ok = true;
    const miss = [];
    for (const f of FIELDS) {
      for (const k of [`stats.fav${f.i18n}Label`, `stats.fav${f.i18n}Ph`]) {
        if (typeof j[k] !== 'string' || j[k].trim() === '') { ok = false; miss.push(k); }
      }
    }
    check(`locales/${lang}.json 含 12 个字段键且非空`, ok, miss.join(', '));
  }
}

console.log('\n' + '='.repeat(52));
console.log('断言：' + pass + ' 通过 / ' + fail + ' 失败');
if (failures.length) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
