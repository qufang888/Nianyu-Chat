// 功能 UI 的 i18n 全量补齐（v3.0.1-beta.4）—— 10 处语言同步。
//
// 背景：用户反馈「调用 Skill 的那个显示似乎没有做 I18N 覆盖，要把软件所有地方的 I18N 全部覆盖全」。
//   · Skill 状态条本身在 v3.0.1-beta.3 已全量 i18n（skill.calling / skill.called / skill.callTip × 10 处语言）。
//   · 但**功能 UI**里仍有一批硬编码中文漏网，本次一并补齐：
//       AboutModal（关于弹窗 6 处）、PendingImageThumb（移除图片 title）、
//       SplashScreen（开屏标题）、floating-ball（悬浮球面板 8 处，独立窗口无 React 上下文）、
//       notify（通知卡片 2 处，独立窗口）、App.tsx（朋友圈提示 toast）、
//       character/behaviors（角色自主气泡台词 7 条）。
//
// 不在本次范围内（**有意为之**，非遗漏）：
//   · GuideView.tsx —— 软件内「使用指南」是根目录《使用说明.md》的**中文原版内嵌**
//     （文件头明确写着「同步约定：本文件内容必须与根目录《使用说明.md》保持一致（文档为权威源）」），
//     该手册本身只有中文版，故此处刻意不译；改译会破坏与文档的同步约定。
//   · Settings.tsx 的 `kw: [...]` —— 设置搜索的**中文关键词表**（用于模糊匹配用户输入的中文），
//     属功能性数据而非可见文案，保留中文是必需的。
//
// 注入方式：仅按行插入/改写（不 json 重写），保持最小 diff；注入后读回校验。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// 10 处语言。zh / zh-Hant 为原生译文；其余 7 种为对应语种译文（非英文兜底）。
const T = {
  zh: {
    'about.logo': '念语',
    'about.sub': 'NIANYU',
    'about.author': 'made by 前方',
    'about.line1': '一款面向深度情感交互的 AI 数字人对话网站。',
    'about.line2': '不追逐流水线模板，不盲从通用框架。',
    'about.line3': '以对话为媒介，搭建虚拟与现实的边界。',
    'about.line4': '万物皆可对话，心意自有回响。',
    'chat.removeImage': '移除图片',
    'splash.logo': '念语',
    'fb.quickChat': '快捷聊天',
    'fb.noChats': '暂无可切换的聊天',
    'fb.scrollHint': '滚轮可滚动查看更多 · 右键悬浮球可退出念语',
    'fb.dragHint': '拖动可调整顺序 · 右键条目可置顶 · 滚轮查看更多',
    'fb.quit': '退出念语',
    'fb.closeBall': '本次关闭悬浮球',
    'fb.pinBall': '悬浮球置顶',
    'fb.pinItem': '置顶',
    'notify.close': '关闭',
    'notify.newMessage': '新消息',
    'moment.postedTo': '「{name}」发布了 {count} 条朋友圈',
    'character.bubble.happy': '嘿嘿。',
    'character.bubble.shy': '别一直盯着我啦。',
    'character.bubble.surprised': '诶？',
    'character.bubble.thinking': '我在想一件事。',
    'character.bubble.yawn': '哈啊——有点困。',
    'character.bubble.angry': '哼。',
    'character.bubble.greet': '你来啦。',
  },
  en: {
    'about.logo': 'Nianyu',
    'about.sub': 'NIANYU',
    'about.author': 'made by Qianfang',
    'about.line1': 'An AI digital-human chat app built for deep emotional interaction.',
    'about.line2': 'No pipeline templates, no blind obedience to generic frameworks.',
    'about.line3': 'Using conversation as the medium to bridge the virtual and the real.',
    'about.line4': 'Everything can be talked about; feelings find their echo.',
    'chat.removeImage': 'Remove image',
    'splash.logo': 'Nianyu',
    'fb.quickChat': 'Quick chat',
    'fb.noChats': 'No chats to switch to',
    'fb.scrollHint': 'Scroll to see more · right-click the ball to quit Nianyu',
    'fb.dragHint': 'Drag to reorder · right-click to pin · scroll for more',
    'fb.quit': 'Quit Nianyu',
    'fb.closeBall': 'Hide the ball this time',
    'fb.pinBall': 'Pin the floating ball',
    'fb.pinItem': 'Pin',
    'notify.close': 'Close',
    'notify.newMessage': 'New message',
    'moment.postedTo': '“{name}” posted {count} new moment(s)',
    'character.bubble.happy': 'Hehe.',
    'character.bubble.shy': "Don't keep staring at me.",
    'character.bubble.surprised': 'Huh?',
    'character.bubble.thinking': 'I was thinking about something.',
    'character.bubble.yawn': 'Haah... a bit sleepy.',
    'character.bubble.angry': 'Hmph.',
    'character.bubble.greet': "You're here.",
  },
  de: {
    'about.logo': 'Nianyu',
    'about.sub': 'NIANYU',
    'about.author': 'made by Qianfang',
    'about.line1': 'Eine KI-Digitalcharakter-Chat-App für tiefe emotionale Interaktion.',
    'about.line2': 'Keine Pipeline-Vorlagen, kein blindes Befolgen allgemeiner Frameworks.',
    'about.line3': 'Mit Gesprächen als Medium, um die Grenze zwischen virtuell und real zu bauen.',
    'about.line4': 'Alles lässt sich besprechen; Gefühle finden ihr Echo.',
    'chat.removeImage': 'Bild entfernen',
    'splash.logo': 'Nianyu',
    'fb.quickChat': 'Schnellchat',
    'fb.noChats': 'Keine Chats zum Wechseln',
    'fb.scrollHint': 'Scrollen für mehr · Rechtsklick auf die Kugel beendet Nianyu',
    'fb.dragHint': 'Ziehen zum Sortieren · Rechtsklick zum Anheften · Scrollen für mehr',
    'fb.quit': 'Nianyu beenden',
    'fb.closeBall': 'Kugel diesmal ausblenden',
    'fb.pinBall': 'Schwebekugel anheften',
    'fb.pinItem': 'Anheften',
    'notify.close': 'Schließen',
    'notify.newMessage': 'Neue Nachricht',
    'moment.postedTo': '„{name}“ hat {count} neue Moment(s) veröffentlicht',
    'character.bubble.happy': 'Hehe.',
    'character.bubble.shy': 'Starr mich nicht so an.',
    'character.bubble.surprised': 'Hm?',
    'character.bubble.thinking': 'Ich denke über etwas nach.',
    'character.bubble.yawn': 'Haah... etwas müde.',
    'character.bubble.angry': 'Tsch.',
    'character.bubble.greet': 'Du bist da.',
  },
  es: {
    'about.logo': 'Nianyu',
    'about.sub': 'NIANYU',
    'about.author': 'made by Qianfang',
    'about.line1': 'Una aplicación de chat con personajes digitales de IA para una interacción emocional profunda.',
    'about.line2': 'Sin plantillas en serie ni obediencia ciega a marcos genéricos.',
    'about.line3': 'Usando la conversación como medio para construir el límite entre lo virtual y lo real.',
    'about.line4': 'Todo se puede conversar; los sentimientos encuentran su eco.',
    'chat.removeImage': 'Quitar imagen',
    'splash.logo': 'Nianyu',
    'fb.quickChat': 'Chat rápido',
    'fb.noChats': 'No hay chats para cambiar',
    'fb.scrollHint': 'Desplaza para ver más · clic derecho en la bola para salir de Nianyu',
    'fb.dragHint': 'Arrastra para reordenar · clic derecho para fijar · desplaza para ver más',
    'fb.quit': 'Salir de Nianyu',
    'fb.closeBall': 'Ocultar la bola por ahora',
    'fb.pinBall': 'Fijar la bola flotante',
    'fb.pinItem': 'Fijar',
    'notify.close': 'Cerrar',
    'notify.newMessage': 'Nuevo mensaje',
    'moment.postedTo': '«{name}» publicó {count} momento(s)',
    'character.bubble.happy': 'Jeje.',
    'character.bubble.shy': 'No me mires fijamente.',
    'character.bubble.surprised': '¿Eh?',
    'character.bubble.thinking': 'Estaba pensando en algo.',
    'character.bubble.yawn': 'Haa... un poco somnoliento.',
    'character.bubble.angry': 'Hmpf.',
    'character.bubble.greet': 'Estás aquí.',
  },
  fr: {
    'about.logo': 'Nianyu',
    'about.sub': 'NIANYU',
    'about.author': 'made by Qianfang',
    'about.line1': 'Une application de chat avec personnages numériques IA pour une interaction émotionnelle profonde.',
    'about.line2': 'Ni gabarits industrialisés, ni soumission aveugle aux cadres génériques.',
    'about.line3': 'La conversation comme médium, pour bâtir la frontière entre le virtuel et le réel.',
    'about.line4': 'Tout peut se dire ; les sentiments trouvent leur écho.',
    'chat.removeImage': "Retirer l'image",
    'splash.logo': 'Nianyu',
    'fb.quickChat': 'Discussion rapide',
    'fb.noChats': 'Aucune discussion à changer',
    'fb.scrollHint': 'Faites défiler pour en voir plus · clic droit sur la bulle pour quitter Nianyu',
    'fb.dragHint': 'Glissez pour réordonner · clic droit pour épingler · défilement pour plus',
    'fb.quit': 'Quitter Nianyu',
    'fb.closeBall': 'Masquer la bulle pour cette fois',
    'fb.pinBall': 'Épingler la bulle flottante',
    'fb.pinItem': 'Épingler',
    'notify.close': 'Fermer',
    'notify.newMessage': 'Nouveau message',
    'moment.postedTo': '« {name} » a publié {count} moment(s)',
    'character.bubble.happy': 'Hé hé.',
    'character.bubble.shy': 'Arrête de me fixer.',
    'character.bubble.surprised': 'Hein ?',
    'character.bubble.thinking': 'Je pensais à quelque chose.',
    'character.bubble.yawn': 'Pffff... un peu fatigué.',
    'character.bubble.angry': 'Hmph.',
    'character.bubble.greet': 'Tu es là.',
  },
  ja: {
    'about.logo': '念語',
    'about.sub': 'NIANYU',
    'about.author': 'made by 前方',
    'about.line1': '深い感情の交流のための、AI デジタル-human チャットアプリ。',
    'about.line2': '流れ作業の型には頼らず、汎用フレームワークを鵜呑みにもしない。',
    'about.line3': '会話を媒介として、仮想と現実の境界をつくる。',
    'about.line4': 'すべてに語りが可能。感情は、共鳴を見つける。',
    'chat.removeImage': '画像を削除',
    'splash.logo': '念語',
    'fb.quickChat': 'クイックチャット',
    'fb.noChats': '切り替えできるチャットがありません',
    'fb.scrollHint': 'スクロールでさらに表示 · ボルを右クリックで念語を終了',
    'fb.dragHint': 'ドラッグで並べ替え · 右クリックで固定 · スクロールでさらに表示',
    'fb.quit': '念語を終了',
    'fb.closeBall': '今回だけボールを隠す',
    'fb.pinBall': 'ボールを固定',
    'fb.pinItem': '固定',
    'notify.close': '閉じる',
    'notify.newMessage': '新着メッセージ',
    'moment.postedTo': '「{name}」が{count}件の投稿をしました',
    'character.bubble.happy': 'に.hehe。',
    'character.bubble.shy': 'ずっと見ないで。',
    'character.bubble.surprised': 'え？',
    'character.bubble.thinking': '何か考えてた。',
    'character.bubble.yawn': 'ハアア…ちょっと眠い。',
    'character.bubble.angry': 'フン。',
    'character.bubble.greet': '来たんだ。',
  },
  ko: {
    'about.logo': '니아뉴',
    'about.sub': 'NIANYU',
    'about.author': 'made by 前方',
    'about.line1': '깊은 정서적 교감을 위한 AI 디지털 휴먼 채팅 앱.',
    'about.line2': '파이프라인 템플릿을 따라가지 않고, 범용 프레임워크를 맹목적으로 따르지도 않습니다.',
    'about.line3': '대화를 매개로 가상의 현실 경계를 만듭니다.',
    'about.line4': '모든 것은 대화할 수 있고, 감정은 울림을 찾습니다.',
    'chat.removeImage': '이미지 제거',
    'splash.logo': '니아뉴',
    'fb.quickChat': '빠른 채팅',
    'fb.noChats': '전환할 채팅이 없습니다',
    'fb.scrollHint': '스크롤하여 더 보기 · 볼을 우클릭하면 니아뉴 종료',
    'fb.dragHint': '드래그하여 순서 변경 · 우클릭하여 고정 · 스크롤하여 더 보기',
    'fb.quit': '니아뉴 종료',
    'fb.closeBall': '이번에는 볼 숨기기',
    'fb.pinBall': '플로팅 볼 고정',
    'fb.pinItem': '고정',
    'notify.close': '닫기',
    'notify.newMessage': '새 메시지',
    'moment.postedTo': '「{name}」님이 {count}개의 모멘트를 발행했습니다',
    'character.bubble.happy': '헤헤.',
    'character.bubble.shy': '계속 쳐다보지 마.',
    'character.bubble.surprised': '엥?',
    'character.bubble.thinking': '생각 중이야.',
    'character.bubble.yawn': '하아... 좀 졸려.',
    'character.bubble.angry': '흠.',
    'character.bubble.greet': '왔네.',
  },
  pt: {
    'about.logo': 'Nianyu',
    'about.sub': 'NIANYU',
    'about.author': 'made by Qianfang',
    'about.line1': 'Um app de chat com personagens digitais de IA para interação emocional profunda.',
    'about.line2': 'Sem modelos de pipeline, sem obediência cega a frameworks genéricos.',
    'about.line3': 'A conversa como meio, construindo a fronteira entre o virtual e o real.',
    'about.line4': 'Tudo pode ser conversado; os sentimentos encontram eco.',
    'chat.removeImage': 'Remover imagem',
    'splash.logo': 'Nianyu',
    'fb.quickChat': 'Chat rápido',
    'fb.noChats': 'Nenhum chat para alternar',
    'fb.scrollHint': 'Role para ver mais · clique com o botão direito na bola para sair do Nianyu',
    'fb.dragHint': 'Arraste para reordenar · clique direito para fixar · role para ver mais',
    'fb.quit': 'Sair do Nianyu',
    'fb.closeBall': 'Ocultar a bola por enquanto',
    'fb.pinBall': 'Fixar a bola flutuante',
    'fb.pinItem': 'Fixar',
    'notify.close': 'Fechar',
    'notify.newMessage': 'Nova mensagem',
    'moment.postedTo': '“{name}” publicou {count} momento(s)',
    'character.bubble.happy': 'Hehe.',
    'character.bubble.shy': 'Para de me olhar.',
    'character.bubble.surprised': 'Huh?',
    'character.bubble.thinking': 'Eu estava pensando em alguma coisa.',
    'character.bubble.yawn': 'Haah... um pouco sonolento.',
    'character.bubble.angry': 'Hmph.',
    'character.bubble.greet': 'Você chegou.',
  },
  ru: {
    'about.logo': 'Nianyu',
    'about.sub': 'NIANYU',
    'about.author': 'made by Qianfang',
    'about.line1': 'Чат-приложение с ИИ-цифровыми персонажами для глубокого эмоционального общения.',
    'about.line2': 'Без конвейерных шаблонов и без слепого подчинения общим фреймворкам.',
    'about.line3': 'Разговор как среда, строящая границу между виртуальным и реальным.',
    'about.line4': 'Обо всём можно поговорить; чувства находят свой отзвук.',
    'chat.removeImage': 'Убрать изображение',
    'splash.logo': 'Nianyu',
    'fb.quickChat': 'Быстрый чат',
    'fb.noChats': 'Нет чатов для переключения',
    'fb.scrollHint': 'Прокрутите, чтобы увидеть больше · правый клик по шарику — выход из Nianyu',
    'fb.dragHint': 'Перетащите, чтобы изменить порядок · правый клик — закрепить · прокрутка — ещё',
    'fb.quit': 'Выйти из Nianyu',
    'fb.closeBall': 'Скрыть шарик в этот раз',
    'fb.pinBall': 'Закрепить плавающий шарик',
    'fb.pinItem': 'Закрепить',
    'notify.close': 'Закрыть',
    'notify.newMessage': 'Новое сообщение',
    'moment.postedTo': '«{name}» опубликовал(а) {count} момент(ов)',
    'character.bubble.happy': 'Хе-хе.',
    'character.bubble.shy': 'Не пялься на меня.',
    'character.bubble.surprised': 'А?',
    'character.bubble.thinking': 'Я о чём-то задумался.',
    'character.bubble.yawn': 'Хаа... немного сонно.',
    'character.bubble.angry': 'Хм.',
    'character.bubble.greet': 'Ты пришёл.',
  },
  'zh-Hant': {
    'about.logo': '念語',
    'about.sub': 'NIANYU',
    'about.author': 'made by 前方',
    'about.line1': '一款面向深度情感互動的 AI 數位人對話網站。',
    'about.line2': '不追逐流水線模板，不盲從通用框架。',
    'about.line3': '以對話為媒介，搭建虛擬與現實的邊界。',
    'about.line4': '萬物皆可對話，心意自有回響。',
    'chat.removeImage': '移除圖片',
    'splash.logo': '念語',
    'fb.quickChat': '快捷聊天',
    'fb.noChats': '暫無可切換的聊天',
    'fb.scrollHint': '滾輪可捲動檢視更多 · 右鍵懸浮球可離開念語',
    'fb.dragHint': '拖動可調整順序 · 右鍵項目可置頂 · 滾輪檢視更多',
    'fb.quit': '離開念語',
    'fb.closeBall': '本次關閉懸浮球',
    'fb.pinBall': '懸浮球置頂',
    'fb.pinItem': '置頂',
    'notify.close': '關閉',
    'notify.newMessage': '新訊息',
    'moment.postedTo': '「{name}」發佈了 {count} 則朋友圈',
    'character.bubble.happy': '嘿嘿。',
    'character.bubble.shy': '別一直盯著我啦。',
    'character.bubble.surprised': '誒？',
    'character.bubble.thinking': '我在想一件事。',
    'character.bubble.yawn': '哈啊——有點困。',
    'character.bubble.angry': '哼。',
    'character.bubble.greet': '你來啦。',
  },
};

function jsStr(s) {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

const KEYS = Object.keys(T.zh);
for (const [lang, dict] of Object.entries(T)) {
  const miss = KEYS.filter((k) => !(k in dict));
  if (miss.length) throw new Error(`${lang} 缺键：${miss.join(',')}`);
}

// ---------- 注入 translations.ts（zh / en 两段）----------
{
  const p = path.join(ROOT, 'src', 'i18n', 'translations.ts');
  let text = fs.readFileSync(p, 'utf-8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(nl);

  const blockRange = (lang) => {
    const startIdx = lines.findIndex((l) => l === `  ${lang}: {`);
    if (startIdx < 0) throw new Error(`translations.ts 找不到 ${lang} 段`);
    let depth = 0;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return [startIdx, i]; }
      }
    }
    throw new Error(`${lang} 段花括号未闭合`);
  };

  for (const lang of ['zh', 'en']) {
    const dict = T[lang];
    const [s, e] = blockRange(lang);
    const seg = lines.slice(s, e + 1);
    const newLines = [];
    let inserted = 0;
    // 幂等：先剔除该语言块里已存在的同键行（避免重复注入）
    const segClean = seg.filter((l) => !KEYS.some((k) => l.includes(`'${k}':`)));
    for (const line of segClean) {
      newLines.push(line);
      // 锚点：about.open（该段已存在的键），在其后插入本批新键
      if (/^\s*'about\.open':/.test(line)) {
        for (const k of KEYS) {
          newLines.push(`    '${k}': ${jsStr(dict[k])},`);
          inserted++;
        }
      }
    }
    if (inserted !== KEYS.length) throw new Error(`${lang} 段只注入了 ${inserted}/${KEYS.length} 键`);
    lines.splice(s, e - s + 1, ...newLines);
  }
  fs.writeFileSync(p, lines.join(nl));
  const back = fs.readFileSync(p, 'utf-8');
  for (const k of KEYS) {
    const n = (back.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':", 'g')) || []).length;
    if (n !== 2) throw new Error(`translations.ts 里 ${k} 出现 ${n} 次（应为 2）`);
  }
  console.log(`  OK  translations.ts  zh + en  各 ${KEYS.length} 键`);
}

// ---------- 注入 8 个 locale JSON ----------
for (const lang of ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']) {
  const p = path.join(ROOT, 'src', 'i18n', 'locales', lang + '.json');
  let text = fs.readFileSync(p, 'utf-8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(nl);
  const dict = T[lang];
  const newLines = [];
  let inserted = 0;
  // 幂等：先剔除已存在的同键行
  for (const line of lines) {
    if (KEYS.some((k) => line.includes(`"${k}":`))) continue;
    newLines.push(line);
    // 锚点：about.open（已存在），在其后插入本批新键
    if (/^\s*"about\.open":/.test(line)) {
      for (const k of KEYS) {
        newLines.push(` "${k}": ${JSON.stringify(dict[k])},`);
        inserted++;
      }
    }
  }
  if (inserted !== KEYS.length) throw new Error(`${lang}.json 只注入了 ${inserted}/${KEYS.length} 键`);
  fs.writeFileSync(p, newLines.join(nl));
  const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  for (const k of KEYS) {
    if (obj[k] !== dict[k]) throw new Error(`${lang}.json 的 ${k} 读回不一致`);
  }
  console.log(`  OK  ${lang}.json  ${KEYS.length} 键`);
}

console.log('== 功能 UI i18n 10 处同步完成 ==');
