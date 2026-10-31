// Skill 状态文案改为符合真实机制的表述（10 处语言同步）。
//
// 背景（v3.0.1-beta.2）：念语的 Skill 是**纯提示词注入**——技能正文以「可用技能」段落写进
// 系统提示词，由模型自行判断是否采用。**不存在运行时调用事件**，也不执行任何脚本。
// 旧文案「正在调用 Skill X / 已完成 Skill 调用」用了「调用」二字，与机制不符 →
// 用户看到状态条却看不到任何"调用"动作，因而怀疑 Skill 没正常工作。
//
// 本脚本做两件事（仅按行插入/替换，不 json 重写，保持最小 diff）：
//   ① 改写已存在的 skill.calling / skill.called 两个键的值（10 处）；
//   ② 新增 skill.callTip 键（10 处）——用作状态条 title，说明真实机制。
//
// 幂等：已存在 skill.callTip 时只改写值、不重复插入。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// 10 处语言：zh / en 在 translations.ts（各 1 段），其余 8 个是 locale JSON。
const T = {
  zh: {
    'skill.calling': '本轮已注入 Skill {name}',
    'skill.called': '本轮已注入 Skill {name}，回复完成',
    'skill.callTip': '技能以「可用技能」段落注入本轮系统提示词，由模型自行判断是否采用——不是运行时调用，也不会执行任何脚本。',
  },
  en: {
    'skill.calling': 'Skill {name} injected this turn',
    'skill.called': 'Skill {name} injected this turn, reply complete',
    'skill.callTip': 'Skills are injected into this turn\'s system prompt as an "Available skills" section; the model itself decides whether to apply them — this is not a runtime call, and no scripts are executed.',
  },
  de: {
    'skill.calling': 'Skill {name} in dieser Runde injiziert',
    'skill.called': 'Skill {name} in dieser Runde injiziert, Antwort fertig',
    'skill.callTip': 'Skills werden als Abschnitt „Verfügbare Fähigkeiten“ in den System-Prompt dieser Runde eingefügt; das Modell entscheidet selbst, ob sie angewendet werden – das ist kein Laufzeitaufruf, und es werden keine Skripte ausgeführt.',
  },
  es: {
    'skill.calling': 'Skill {name} inyectado en este turno',
    'skill.called': 'Skill {name} inyectado en este turno, respuesta completada',
    'skill.callTip': 'Las habilidades se inyectan como sección «Habilidades disponibles» en el prompt de sistema de este turno; el propio modelo decide si las aplica: no es una llamada en tiempo de ejecución y no se ejecuta ningún script.',
  },
  fr: {
    'skill.calling': 'Skill {name} injecté dans ce tour',
    'skill.called': 'Skill {name} injecté dans ce tour, réponse terminée',
    'skill.callTip': "Les skills sont injectés comme section « Skills disponibles » dans le prompt système de ce tour ; le modèle décide lui-même s'il les applique — ce n'est pas un appel à l'exécution, et aucun script n'est lancé.",
  },
  ja: {
    'skill.calling': 'このターンで Skill {name} を注入済み',
    'skill.called': 'このターンで Skill {name} を注入済み（返信完了）',
    'skill.callTip': 'スキルは「利用可能なスキル」セクションとしてこのターンのシステムプロンプトに注入されます。モデルが自分で適用するか判断します（実行時呼び出しではなく、スクリプトの実行も行いません）。',
  },
  ko: {
    'skill.calling': '이번 턴에 Skill {name} 주입됨',
    'skill.called': '이번 턴에 Skill {name} 주입됨, 응답 완료',
    'skill.callTip': '스킬은 「사용 가능한 스킬」 섹션으로 이번 턴의 시스템 프롬프트에 주입됩니다. 모델이 적용 여부를 직접 판단합니다(런타임 호출이 아니며 스크립트는 실행되지 않음).',
  },
  pt: {
    'skill.calling': 'Skill {name} injetado neste turno',
    'skill.called': 'Skill {name} injetado neste turno, resposta concluída',
    'skill.callTip': 'As habilidades são injetadas como seção "Habilidades disponíveis" no prompt de sistema deste turno; o próprio modelo decide se as aplica — não é uma chamada em tempo de execução e nenhum script é executado.',
  },
  ru: {
    'skill.calling': 'Skill {name} внедрён в этот ход',
    'skill.called': 'Skill {name} внедрён в этот ход, ответ готов',
    'skill.callTip': 'Навыки добавляются в системный промпт этого хода как раздел «Доступные навыки»; сама модель решает, применять ли их — это не вызов во время выполнения, скрипты не запускаются.',
  },
  'zh-Hant': {
    'skill.calling': '本輪已注入 Skill {name}',
    'skill.called': '本輪已注入 Skill {name}，回覆完成',
    'skill.callTip': '技能會以「可用技能」段落注入本輪系統提示詞，由模型自行判斷是否採用——非執行階段呼叫，也不會執行任何腳本。',
  },
};

function jsStr(s) {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
function jsonStr(s) {
  return JSON.stringify(s);
}

/** 按行改写某个键的值；返回 [新行数组, 命中次数] */
function rewriteKey(lines, key, value, lang, isTs) {
  const pat = isTs
    ? new RegExp("^(\\s*)'" + key.replace(/\./g, '\\.') + "':\\s*'.*',?\\s*$")
    : new RegExp("^(\\s*)\"" + key.replace(/\./g, '\\.') + "\":\\s*.*,?\\s*$");
  const out = [];
  let hits = 0;
  for (const line of lines) {
    const m = line.match(pat);
    if (!m) {
      out.push(line);
      continue;
    }
    hits++;
    const indent = m[1];
    out.push(isTs ? `${indent}'${key}': ${jsStr(value)},` : `${indent}"${key}": ${jsonStr(value)},`);
  }
  return [out, hits];
}

/** 在指定键所在行之后插入新键行 */
function insertAfterKey(lines, anchorKey, newKey, value, lang, isTs) {
  const pat = isTs
    ? new RegExp("^(\\s*)'" + anchorKey.replace(/\./g, '\\.') + "':")
    : new RegExp("^(\\s*)\"" + anchorKey.replace(/\./g, '\\.') + "\":");
  const out = [];
  let hit = false;
  for (const line of lines) {
    out.push(line);
    if (!hit && pat.test(line)) {
      const indent = (line.match(pat) || [])[1] || '';
      out.push(isTs ? `${indent}'${newKey}': ${jsStr(value)},` : `${indent}"${newKey}": ${jsonStr(value)},`);
      hit = true;
    }
  }
  return [out, hit];
}

// ---------- translations.ts（zh + en 两段）----------
{
  const p = path.join(ROOT, 'src', 'i18n', 'translations.ts');
  let text = fs.readFileSync(p, 'utf-8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(nl);

  // zh / en 两段内联在同一文件里 —— 必须**按段**定位，否则改 zh 时会把 en 一起改掉。
  const blockRange = (lang) => {
    const startIdx = lines.findIndex((l) => l === `  ${lang}: {`);
    if (startIdx < 0) throw new Error(`translations.ts 找不到 ${lang} 段起点`);
    let depth = 0;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return [startIdx, i];
        }
      }
    }
    throw new Error(`translations.ts 的 ${lang} 段花括号未闭合`);
  };

  const applyBlock = (lang, dict) => {
    const [s, e] = blockRange(lang);
    const seg = lines.slice(s, e + 1);
    for (const key of ['skill.calling', 'skill.called']) {
      const [out, hits] = rewriteKey(seg, key, dict[key], lang, true);
      if (hits !== 1) throw new Error(`translations.ts ${lang} 段 ${key} 命中 ${hits} 次（应为 1）`);
      seg.length = 0;
      seg.push(...out);
    }
    if (text.includes("'skill.callTip':")) {
      const [out, hits] = rewriteKey(seg, 'skill.callTip', dict['skill.callTip'], lang, true);
      if (hits !== 1) throw new Error(`translations.ts ${lang} 段 skill.callTip 命中 ${hits} 次（应为 1）`);
      seg.length = 0;
      seg.push(...out);
    } else {
      const [out, hit] = insertAfterKey(seg, 'skill.called', 'skill.callTip', dict['skill.callTip'], lang, true);
      if (!hit) throw new Error(`translations.ts ${lang} 段找不到 skill.called 锚点`);
      seg.length = 0;
      seg.push(...out);
    }
    lines.splice(s, e - s + 1, ...seg);
  };

  applyBlock('zh', T.zh);
  applyBlock('en', T.en);

  fs.writeFileSync(p, lines.join(nl));
  const back = fs.readFileSync(p, 'utf-8');
  for (const k of ['skill.calling', 'skill.called', 'skill.callTip']) {
    const n = (back.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':", 'g')) || []).length;
    if (n !== 2) throw new Error(`translations.ts 里 ${k} 出现 ${n} 次（应为 2）`);
  }
  console.log('  OK  translations.ts  zh + en  各 3 键');
}

// ---------- 8 个 locale JSON ----------
for (const lang of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
  const p = path.join(ROOT, 'src', 'i18n', 'locales', lang + '.json');
  let text = fs.readFileSync(p, 'utf-8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(nl);
  const dict = T[lang];

  for (const key of ['skill.calling', 'skill.called']) {
    const [out, hits] = rewriteKey(lines, key, dict[key], lang, false);
    if (hits !== 1) throw new Error(`${lang}.json ${key} 命中 ${hits} 次（应为 1）`);
    lines = out;
  }
  if (text.includes('"skill.callTip":')) {
    const [out, hits] = rewriteKey(lines, 'skill.callTip', dict['skill.callTip'], lang, false);
    if (hits !== 1) throw new Error(`${lang}.json skill.callTip 命中 ${hits} 次（应为 1）`);
    lines = out;
  } else {
    // 插到 skill.calling 之后 → 维持文件既有的字母序（called < calling < callTip < count）
    const [out, hit] = insertAfterKey(lines, 'skill.calling', 'skill.callTip', dict['skill.callTip'], lang, false);
    if (!hit) throw new Error(`${lang}.json 找不到 skill.calling 锚点`);
    lines = out;
  }
  fs.writeFileSync(p, lines.join(nl));

  // 读回校验（JSON 合法性 + 值一致 + 键序未乱）
  const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  for (const k of ['skill.calling', 'skill.called', 'skill.callTip']) {
    if (obj[k] !== dict[k]) throw new Error(`${lang}.json 的 ${k} 读回不一致`);
  }
  console.log(`  OK  ${lang}.json  3 键`);
}

console.log('== Skill 状态文案 10 处同步完成 ==');
