// 桌宠角色气泡文案的 i18n 键注入（v3.0.1-beta.4）—— 10 处语言同步。
//
// 背景：src/character/behaviors.ts 原先直接存中文原文（角色待机/点击/拖拽气泡），
//   导致非中文界面下角色仍说中文 → 现改为**只存 i18n 键**，由 CharacterApp 用 translate() 解析。
// 键名：character.bubble.{情绪}（IDLE_ACTIONS.text）+ character.idle.{n} / click.{n} / drag.{n}（台词池）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const T = {
  zh: {
    'character.idle.1':'我在这儿。','character.idle.2':'今天也一起待着吧。','character.idle.3':'你忙你的，我不吵你。',
    'character.idle.4':'刚刚走神了一下。','character.idle.5':'要不要休息一会儿？','character.idle.6':'窗外好像有风。',
    'character.idle.7':'我一直都在。','character.idle.8':'有点想说话了。','character.idle.9':'伸个懒腰。',
    'character.idle.10':'你回来啦。','character.idle.11':'喝口水吧。','character.idle.12':'时间过得真快。',
    'character.click.1':'嗯？','character.click.2':'我在。','character.click.3':'怎么啦？','character.click.4':'摸摸头。','character.click.5':'有事找我？',
    'character.drag.1':'哇——','character.drag.2':'轻一点啦。','character.drag.3':'要带我去哪儿？','character.drag.4':'晕乎乎的。',
  },
  en: {
    'character.idle.1':"I'm here.",'character.idle.2':"Let's spend some time together today.",'character.idle.3':"Go ahead, I'll be quiet.",
    'character.idle.4':'I drifted off for a second.','character.idle.5':'Want to take a break?','character.idle.6':'It looks windy outside.',
    'character.idle.7':"I'm always here.",'character.idle.8':"I feel like talking.",'character.idle.9':'Stretching.',
    'character.idle.10':"You're back.",'character.idle.11':'Have some water.','character.idle.12':'Time flies.',
    'character.click.1':'Hm?','character.click.2':"I'm here.",'character.click.3':'What is it?','character.click.4':'Pat on the head.','character.click.5':'Need me?',
    'character.drag.1':'Whoa—','character.drag.2':'Gently, please.','character.drag.3':'Where are we going?','character.drag.4':'Feeling dizzy.',
  },
  de: {
    'character.idle.1':'Ich bin da.','character.idle.2':'Lass uns heute zusammen sein.','character.idle.3':'Mach dein Zeug, ich bin still.',
    'character.idle.4':'Ich war kurz abwesend.','character.idle.5':'Wollen wir eine Pause machen?','character.idle.6':'Draußen sieht es windig aus.',
    'character.idle.7':'Ich bin immer da.','character.idle.8':'Ich möchte etwas sagen.','character.idle.9':'Gähne.',
    'character.idle.10':'Du bist zurück.','character.idle.11':'Trink etwas Wasser.','character.idle.12':'Die Zeit vergeht schnell.',
    'character.click.1':'Hm?','character.click.2':'Ich bin da.','character.click.3':'Was ist los?','character.click.4':'Kopf streicheln.','character.click.5':'Brauchst du mich?',
    'character.drag.1':'Hoppla—','character.drag.2':'Bitte sanfter.','character.drag.3':'Wohin gehen wir?','character.drag.4':'Mir wird schwindelig.',
  },
  es: {
    'character.idle.1':'Aquí estoy.','character.idle.2':'Pasemos un rato juntos hoy.','character.idle.3':'Tú sigue, yo me callo.',
    'character.idle.4':'Me he distraído un momento.','character.idle.5':'¿Descansamos un poco?','character.idle.6':'Parece que hace viento fuera.',
    'character.idle.7':'Siempre estoy aquí.','character.idle.8':'Me apetece hablar.','character.idle.9':'Estiro.',
    'character.idle.10':'Has vuelto.','character.idle.11':'Bebe agua.','character.idle.12':'El tiempo vuela.',
    'character.click.1':'¿Eh?','character.click.2':'Aquí estoy.','character.click.3':'¿Qué pasa?','character.click.4':'Una caricia.','character.click.5':'¿Necesitas algo?',
    'character.drag.1':'¡Ay—','character.drag.2':'Más suave, por favor.','character.drag.3':'¿Adónde vamos?','character.drag.4':'Me mareo.',
  },
  fr: {
    'character.idle.1':'Je suis là.','character.idle.2':'Passons un moment ensemble aujourd’hui.','character.idle.3':'Occupes-toi, je reste discret.',
    'character.idle.4':'J’ai rêvassé un instant.','character.idle.5':'On fait une pause ?','character.idle.6':'Il semble faire du vent dehors.',
    'character.idle.7':'Je suis toujours là.','character.idle.8':'J’ai envie de parler.','character.idle.9':'Je bâille.',
    'character.idle.10':'Tu es de retour.','character.idle.11':'Bois de l’eau.','character.idle.12':'Le temps passe vite.',
    'character.click.1':'Hm ?','character.click.2':'Je suis là.','character.click.3':'Quoi ?','character.click.4':'Une caresse.','character.click.5':'Tu as besoin de moi ?',
    'character.drag.1':'Oups—','character.drag.2':'Plus doucement, s’il te plaît.','character.drag.3':'On va où ?','character.drag.4':'J’ai la tête qui tourne.',
  },
  ja: {
    'character.idle.1':'ここにいるよ。','character.idle.2':'今日も一緒にいよう。','character.idle.3':'clicccは忙しないよ。',
    'character.idle.4':'ちょっとぼーっとした。','character.idle.5':'休憩しない？','character.idle.6':'外の風anet万象に見えた。',
    'character.idle.7':'ずっとここにいる。','character.idle.8':'話したくなってきた。','character.idle.9':'伸びをする。',
    'character.idle.10':'おかえり。','character.idle.11':'お水を飲んで。','character.idle.12':'時間ってすぐに過ぎるよね。',
    'character.click.1':'ん？','character.click.2':'いるよ。','character.click.3':'どうしたの？','character.click.4':'なでなで。','character.click.5':'何かある？',
    'character.drag.1':'わあー','character.drag.2':'もうちょっとやさしく。','character.drag.3':'どこ行くの？','character.drag.4':'ふらふらする。',
  },
  ko: {
    'character.idle.1':'여기 있어.','character.idle.2':'오늘도 같이 있자.','character.idle.3':'바各异，我会安静。',
    'character.idle.4':'조금 멍때렸어.','character.idle.5':'쉬어 볼까?','character.idle.6':'밖에는 바람이 부는 것 같아.',
    'character.idle.7':'항상 여기 있어.','character.idle.8':'말하고 싶어졌어.','character.idle.9':'기지개를 켜.',
    'character.idle.10':'돌아왔네.','character.idle.11':'물 한 잔 마셔.','character.idle.12':'시간 참 빠르다.',
    'character.click.1':'음?','character.click.2':'여기 있어.','character.click.3':'무슨 일?','character.click.4':'쓰다듬어.','character.click.5':'뭔데?',
    'character.drag.1':'Wah—','character.drag.2':'조금만 살살.','character.drag.3':'어디 가는 거야?','character.drag.4':'어지러워.',
  },
  pt: {
    'character.idle.1':'Estou aqui.','character.idle.2':'Vamos ficar juntos hoje.','character.idle.3':'Segue teu trabalho, eu fico quieta.',
    'character.idle.4':'Distraí-me um segundo.','character.idle.5':'Quer fazer uma pausa?','character.idle.6':'Parece que está vento lá fora.',
    'character.idle.7':'Estou sempre aqui.','character.idle.8':'Tenho vontade de falar.','character.idle.9':'Bocejo.',
    'character.idle.10':'Voltaste.','character.idle.11':'Bebe um pouco de água.','character.idle.12':'O tempo passa depressa.',
    'character.click.1':'Hm?','character.click.2':'Estou aqui.','character.click.3':'Que foi?','character.click.4':'Cozinha na cabeça.','character.click.5':'Precisas de mim?',
    'character.drag.1':'Whoa—','character.drag.2':'Mais devagar, por favor.','character.drag.3':'Para onde vamos?','character.drag.4':'Estou tonto.',
  },
  ru: {
    'character.idle.1':'Я здесь.','character.idle.2':'Давай вместе побудем сегодня.','character.idle.3':'Занимайся, я не помешаю.',
    'character.idle.4':'Немного отвлёкся.','character.idle.5':'Отдохнуть?','character.idle.6':'Снаружи как будто ветер.',
    'character.idle.7':'Я всегда здесь.','character.idle.8':'Хочется поговорить.','character.idle.9':'Потягиваюсь.',
    'character.idle.10':'Ты вернулся.','character.idle.11':'Выпей воды.','character.idle.12':'Время летит быстро.',
    'character.click.1':'М?','character.click.2':'Я здесь.','character.click.3':'Что?','character.click.4':'Гладишь по голове.','character.click.5':'Нужна помощь?',
    'character.drag.1':'Ого—','character.drag.2':'Полегче, пожалуйста.','character.drag.3':'Куда идём?','character.drag.4':'Голова кружится.',
  },
  'zh-Hant': {
    'character.idle.1':'我在這裡。','character.idle.2':'今天也一起待著吧。','character.idle.3':'你忙你的，我不吵你。',
    'character.idle.4':'剛剛走神了一下。','character.idle.5':'要不要休息一會兒？','character.idle.6':'窗外好像有風。',
    'character.idle.7':'我一直都在。','character.idle.8':'有點想說話了。','character.idle.9':'伸個懶腰。',
    'character.idle.10':'你回來啦。','character.idle.11':'喝口水吧。','character.idle.12':'時間過得真快。',
    'character.click.1':'嗯？','character.click.2':'我在。','character.click.3':'怎麼啦？','character.click.4':'摸摸頭。','character.click.5':'有事找我？',
    'character.drag.1':'哇——','character.drag.2':'輕一點啦。','character.drag.3':'要帶我去哪兒？','character.drag.4':'暈乎乎的。',
  },
};

const KEYS = Object.keys(T.zh);
for (const [lang, dict] of Object.entries(T)) {
  const miss = KEYS.filter((k) => !(k in dict));
  if (miss.length) throw new Error(`${lang} 缺键：${miss.join(',')}`);
}
const jsStr = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// ---------- translations.ts（zh / en 两段）----------
{
  const p = path.join(ROOT, 'src', 'i18n', 'translations.ts');
  let text = fs.readFileSync(p, 'utf-8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(nl);
  const blockRange = (lang) => {
    const s0 = lines.findIndex((l) => l === `  ${lang}: {`);
    if (s0 < 0) throw new Error(`找不到 ${lang} 段`);
    let d = 0;
    for (let i = s0; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') d++;
        else if (ch === '}') { d--; if (d === 0) return [s0, i]; }
      }
    }
    throw new Error(`${lang} 段未闭合`);
  };
  for (const lang of ['zh', 'en']) {
    const dict = T[lang];
    const [s0, e0] = blockRange(lang);
    const seg = lines.slice(s0, e0 + 1).filter((l) => !KEYS.some((k) => l.includes(`'${k}':`)));
    const out = [];
    let n = 0;
    for (const line of seg) {
      out.push(line);
      if (/^\s*'character\.bubble\.greet':/.test(line)) {
        for (const k of KEYS) { out.push(`    '${k}': ${jsStr(dict[k])},`); n++; }
      }
    }
    if (n !== KEYS.length) throw new Error(`${lang} 段注入 ${n}/${KEYS.length}`);
    lines.splice(s0, e0 - s0 + 1, ...out);
  }
  fs.writeFileSync(p, lines.join(nl));
  const back = fs.readFileSync(p, 'utf-8');
  for (const k of KEYS) {
    const c = (back.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':", 'g')) || []).length;
    if (c !== 2) throw new Error(`translations.ts 里 ${k} 出现 ${c} 次（应为 2）`);
  }
  console.log(`  OK  translations.ts  zh + en  各 ${KEYS.length} 键`);
}

// ---------- 8 个 locale JSON ----------
for (const lang of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
  const p = path.join(ROOT, 'src', 'i18n', 'locales', lang + '.json');
  let text = fs.readFileSync(p, 'utf-8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const dict = T[lang];
  const out = [];
  let n = 0;
  for (const line of text.split(nl)) {
    if (KEYS.some((k) => line.includes(`"${k}":`))) continue;
    out.push(line);
    if (/^\s*"character\.bubble\.greet":/.test(line)) {
      for (const k of KEYS) { out.push(` "${k}": ${JSON.stringify(dict[k])},`); n++; }
    }
  }
  if (n !== KEYS.length) throw new Error(`${lang}.json 注入 ${n}/${KEYS.length}`);
  fs.writeFileSync(p, out.join(nl));
  const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  for (const k of KEYS) if (obj[k] !== dict[k]) throw new Error(`${lang}.json 的 ${k} 读回不一致`);
  console.log(`  OK  ${lang}.json  ${KEYS.length} 键`);
}
console.log('== 角色气泡 i18n 10 处同步完成 ==');
