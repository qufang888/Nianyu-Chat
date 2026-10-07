// 一次性脚本：把 v2.3.97 拖拽导入预检弹窗的新增文案注入 8 个 locales/*.json
// 用法：node scripts/i18n-v2397-quick-import-preview.mjs
// 幂等：已存在的键会被跳过。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LOCALES_DIR = path.join(ROOT, 'src/i18n/locales');

// 新增 key → { lang: 译文 }
const ADDITIONS = {
  'quickimport.err_unknown': {
    fr: 'Format de fichier non reconnu',
    de: 'Nicht erkennbares Dateiformat',
    ja: '認識できないファイル形式です',
    ko: '인식할 수 없는 파일 형식입니다',
    es: 'Formato de archivo no reconocido',
    pt: 'Formato de ficheiro não reconhecido',
    ru: 'Нераспознанный формат файла',
    'zh-Hant': '無法辨識的檔案格式',
  },
  'quickimport.preview.title': {
    fr: 'Confirmer l’import',
    de: 'Import bestätigen',
    ja: 'インポートを確認',
    ko: '가져오기 확인',
    es: 'Confirmar importación',
    pt: 'Confirmar importação',
    ru: 'Подтвердите импорт',
    'zh-Hant': '確認匯入',
  },
  'quickimport.preview.desc': {
    fr: 'Fichiers reconnus ci-dessous. Rien n’est écrit avant votre confirmation ; Annuler ne fait rien.',
    de: 'Unten erkannte Dateien. Es wird nichts geschrieben, bevor du bestätigst; Abbrechen bewirkt nichts.',
    ja: 'below が認識されたファイルです。確認するまで何も保存されません。キャンセルは何も起きません。',
    ko: '아래에서 인식된 파일입니다. 확인하기 전까지는 아무것도 저장되지 않으며, 취소하면 아무 일도 일어나지 않습니다.',
    es: 'Archivos reconocidos abajo. No se escribe nada hasta que confirmes; Cancelar no hace nada.',
    pt: 'Ficheiros reconhecidos abaixo. Nada é escrito até confirmares; Cancelar não faz nada.',
    ru: 'Распознанные файлы показаны ниже. До подтверждения ничего не записывается; «Отмена» ничего не делает.',
    'zh-Hant': '以下是辨識到的檔案。確認前不會寫入任何資料；取消則什麼都不會發生。',
  },
  'quickimport.preview.loading': {
    fr: 'Lecture des informations du fichier…',
    de: 'Dateiinformationen werden gelesen…',
    ja: 'ファイル情報を読み込み中…',
    ko: '파일 정보를 읽는 중…',
    es: 'Leyendo información del archivo…',
    pt: 'A ler as informações do ficheiro…',
    ru: 'Чтение сведений о файле…',
    'zh-Hant': '正在讀取檔案資訊…',
  },
  'quickimport.preview.empty': {
    fr: 'Aucun fichier reconnaissable',
    de: 'Keine erkennbaren Dateien',
    ja: '認識できるファイルがありません',
    ko: '인식할 수 있는 파일이 없습니다',
    es: 'No hay archivos reconocibles',
    pt: 'Não há ficheiros reconhecíveis',
    ru: 'Нет распознаваемых файлов',
    'zh-Hant': '沒有可辨識的檔案',
  },
  'quickimport.preview.failed': {
    fr: 'Échec de la lecture des informations du fichier, veuillez réessayer',
    de: 'Dateiinformationen konnten nicht gelesen werden, bitte erneut versuchen',
    ja: 'ファイル情報を読み込めませんでした。もう一度お試しください',
    ko: '파일 정보를 읽지 못했습니다. 다시 시도해 주세요',
    es: 'No se pudo leer la información del archivo; inténtalo de nuevo',
    pt: 'Não foi possível ler as informações do ficheiro; tenta de novo',
    ru: 'Не удалось прочитать сведения о файле. Попробуйте ещё раз',
    'zh-Hant': '讀取檔案資訊失敗，請重試',
  },
  'quickimport.preview.cancel': {
    fr: 'Annuler',
    de: 'Abbrechen',
    ja: 'キャンセル',
    ko: '취소',
    es: 'Cancelar',
    pt: 'Cancelar',
    ru: 'Отмена',
    'zh-Hant': '取消',
  },
  'quickimport.preview.importOnly': {
    fr: 'Importer seulement',
    de: 'Nur importieren',
    ja: 'インポートのみ',
    ko: '가져오기만',
    es: 'Solo importar',
    pt: 'Apenas importar',
    ru: 'Только импорт',
    'zh-Hant': '僅匯入',
  },
  'quickimport.preview.importAndEdit': {
    fr: 'Importer et modifier',
    de: 'Importieren und bearbeiten',
    ja: 'インポートして編集',
    ko: '가져온 뒤 편집',
    es: 'Importar y editar',
    pt: 'Importar e editar',
    ru: 'Импорт и правка',
    'zh-Hant': '匯入並編輯',
  },
  'quickimport.preview.noEditable': {
    fr: 'Aucun type modifiable après l’import (les plugins ne sont pas encore modifiables)',
    de: 'Nichts ist nach dem Import bearbeitbar (Plugins noch nicht bearbeitbar)',
    ja: 'インポート後に編集できる項目はありません（プラグインは未対応）',
    ko: '가져온 뒤 편집할 수 있는 항목이 없습니다(플러그인은 아직 편집 불가)',
    es: 'Nada editable tras la importación (los complementos aún no se pueden editar)',
    pt: 'Nada editável após a importação (os plug-ins ainda não são editáveis)',
    ru: 'После импорта нечего править (плагины пока не редактируются)',
    'zh-Hant': '沒有可匯入後編輯的類型（外掛尚不支援匯入後編輯）',
  },
  'quickimport.preview.badLabel': {
    fr: 'Import impossible',
    de: 'Import nicht möglich',
    ja: 'インポートできません',
    ko: '가져올 수 없음',
    es: 'No se puede importar',
    pt: 'Não é possível importar',
    ru: 'Импорт невозможен',
    'zh-Hant': '無法匯入',
  },
  'quickimport.preview.badHint': {
    fr: 'Les fichiers en rouge ne peuvent pas être importés ; « Importer seulement » les ignore automatiquement.',
    de: 'Rot markierte Dateien können nicht importiert werden; „Nur importieren“ überspringt sie automatisch.',
    ja: '赤く表示されたファイルはインポートできません。「インポートのみ」は自動的にスキップします。',
    ko: '빨간색으로 표시된 파일은 가져올 수 없습니다. ‘가져오기만’을 누르면 자동으로 건너뜁니다.',
    es: 'Los archivos en rojo no se pueden importar; «Solo importar» los omite automáticamente.',
    pt: 'Os ficheiros a vermelho não podem ser importados; «Apenas importar» ignora-os automaticamente.',
    ru: 'Файлы, выделенные красным, импортировать нельзя; «Только импорт» пропустит их автоматически.',
    'zh-Hant': '標紅的檔案無法匯入；「僅匯入」會自動略過它們。',
  },
  'quickimport.preview.truncated': {
    fr: '{n} fichier(s) non listés (au maximum {limit} par dépôt).',
    de: '{n} weitere Datei(en) nicht aufgeführt (höchstens {limit} pro Ablegevorgang).',
    ja: 'ほかに {n} 件のファイルがあります（1回の上限は {limit} 件です）。',
    ko: '목록에 표시되지 않은 파일 {n}개가 더 있습니다(한 번에 최대 {limit}개).',
    es: 'Hay {n} archivo(s) más sin listar (máximo {limit} por arrastre).',
    pt: 'Mais {n} ficheiro(s) não listados (no máximo {limit} por largada).',
    ru: 'Ещё {n} файл(ов) не показано (не более {limit} за одно перетаскивание).',
    'zh-Hant': '另有 {n} 個檔案未列出（單次最多處理 {limit} 個）。',
  },
  'quickimport.preview.entries': {
    fr: 'Entrées',
    de: 'Einträge',
    ja: 'エントリ',
    ko: '항목',
    es: 'Entradas',
    pt: 'Entradas',
    ru: 'Записи',
    'zh-Hant': '項目',
  },
  'quickimport.preview.keys': {
    fr: 'Mots-clés',
    de: 'Schlüsselwörter',
    ja: 'キーワード',
    ko: '키워드',
    es: 'Palabras clave',
    pt: 'Palavras-chave',
    ru: 'Ключевые слова',
    'zh-Hant': '關鍵字',
  },
  'quickimport.preview.chars': {
    fr: 'Caractères',
    de: 'Zeichen',
    ja: '文字数',
    ko: '글자 수',
    es: 'Caracteres',
    pt: 'Caracteres',
    ru: 'Символы',
    'zh-Hant': '字數',
  },
  'quickimport.preview.tools': {
    fr: 'Outils',
    de: 'Werkzeuge',
    ja: 'ツール',
    ko: '도구',
    es: 'Herramientas',
    pt: 'Ferramentas',
    ru: 'Инструменты',
    'zh-Hant': '工具',
  },
  'quickimport.preview.segments': {
    fr: 'Segments de prompt',
    de: 'Prompt-Segmente',
    ja: 'プロンプト断片',
    ko: '프롬프트 조각',
    es: 'Segmentos de prompt',
    pt: 'Segmentos de prompt',
    ru: 'Сегменты промпта',
    'zh-Hant': '提示詞片段',
  },
  'quickimport.preview.editHint': {
    fr: 'Cliquez sur « Enregistrer » pour importer réellement ; « Annuler » signifie que cet élément n’est pas importé du tout.',
    de: 'Klicke auf „Speichern“, um wirklich zu importieren; „Abbrechen“ heißt, dieser Eintrag wird gar nicht importiert.',
    ja: '「保存」を押すと実際にインポートされます。「キャンセル」ならこの項目はまったくインポートされません。',
    ko: '‘저장’을 눌러야 실제로 가져옵니다. ‘취소’를 누르면 이 항목은 전혀 가져오지 않습니다.',
    es: 'Pulsa «Guardar» para importarlo de verdad; «Cancelar» hace que este elemento no se importe en absoluto.',
    pt: 'Clique em «Guardar» para importar de facto; «Cancelar» significa que este item não é importado.',
    ru: 'Нажмите «Сохранить», чтобы импортировать; «Отмена» — этот элемент вообще не будет импортирован.',
    'zh-Hant': '點「儲存」才會真正匯入；點「取消」表示這一項完全不會匯入。',
  },
  'quickimport.preview.edited': {
    fr: 'Import terminé ; vous pouvez continuer à modifier dans la bibliothèque.',
    de: 'Import abgeschlossen; du kannst in der Bibliothek weiter bearbeiten.',
    ja: 'インポート完了。資料庫で引き続き編集できます。',
    ko: '가져오기 완료. 자료실에서 계속 편집할 수 있습니다.',
    es: 'Importación completada; puedes seguir editando en la biblioteca.',
    pt: 'Importação concluída; podes continuar a editar na biblioteca.',
    ru: 'Импорт завершён; продолжать редактирование можно в библиотеке.',
    'zh-Hant': '匯入完成，可在資料庫中繼續編輯。',
  },
};

let changed = 0;
for (const [key, byLang] of Object.entries(ADDITIONS)) {
  for (const [lang, text] of Object.entries(byLang)) {
    const file = path.join(LOCALES_DIR, `${lang}.json`);
    const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (dict[key]) {
      console.log(`  SKIP  ${lang}.json  ${key}（已存在）`);
      continue;
    }
    dict[key] = text;
    fs.writeFileSync(file, JSON.stringify(dict, null, 1) + '\n', 'utf8');
    console.log(`  ADD   ${lang}.json  ${key}`);
    changed++;
  }
}
console.log(`\n共写入 ${changed} 条。`);