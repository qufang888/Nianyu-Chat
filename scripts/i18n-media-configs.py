#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2.3.94 需求 7：TTS / ASR / 生图 / 生视频 多API 配置 UI —— i18n 批量同步。

与 scripts/i18n-awaiting-reply.py 同款做法：
  - translations.ts 的 zh / en 两段：就地插入到锚点键之后，保持键序稳定；
  - src/i18n/locales/ 下 8 个 JSON：同样插到锚点之后（幂等，重复跑不会重复插入）。

每种语言给真实翻译（非机翻）：涉及「模型设置 / 多条配置 / 当前使用」等术语，
统一沿用各语言既有译法（如settings.modelManage 的译名）。
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES = os.path.join(ROOT, 'src', 'i18n', 'locales')
TRANSLATIONS = os.path.join(ROOT, 'src', 'i18n', 'translations.ts')

# 锚点键：新键插到它之后（与既有段落顺序对齐，便于日后 diff）
ANCHOR = 'settings.ttsProvPolly'

# ===== key -> {lang: text}（10 种语言）=====
NEW = {
    # ---------- 通用交互 ----------
    'settings.mcfg.hint': {
        'zh': '可添加多条配置并随时切换：标记为「当前使用」的那一条会被实际调用，其余作为备用保留，随时可切。',
        'en': 'You can add several configurations and switch at any time: the one marked "Active" is the one actually called; the rest are kept as backups you can switch to.',
        'de': 'Du kannst mehrere Konfigurationen anlegen und jederzeit wechseln: Die als "Aktiv" markierte wird tatsächlich aufgerufen, die anderen bleiben als Ersatz gespeichert.',
        'es': 'Puedes añadir varias configuraciones y cambiar en cualquier momento: la marcada como «Activa» es la que se usa realmente; las demás se guardan como alternativa.',
        'fr': 'Vous pouvez ajouter plusieurs configurations et changer à tout moment : celle marquée « Active » est réellement utilisée ; les autres sont conservées en réserve.',
        'ja': '複数の設定を追加していつでも切り替えられます。「使用中」と表示された設定が実際に使われるもので、���のは控えとして保存されます。',
        'ko': '여러 설정을 추가하고 언제든지 전환할 수 있습니다. 「사용 중」으로 표시된 설정만 실제로 사용되며, 나머지는备用로 보관됩니다.',
        'pt': 'Você pode adicionar várias configurações e trocar a qualquer momento: a marcada como "Ativa" é a realmente usada; as demais ficam guardadas como reserva.',
        'ru': 'Можно добавить несколько конфигураций и переключаться между ними: помеченная «Активная» действительно используется, остальные хранятся как запасные.',
        'zh-Hant': '可新增多組設定並隨時切換：標記為「使用中」的那一組會實際被呼叫，其餘作為備用保留，隨時可切換。',
    },
    'settings.mcfg.add': {
        'zh': '添加配置',
        'en': 'Add configuration',
        'de': 'Konfiguration hinzufügen',
        'es': 'Añadir configuración',
        'fr': 'Ajouter une configuration',
        'ja': '設定を追加',
        'ko': '설정 추가',
        'pt': 'Adicionar configuração',
        'ru': 'Добавить конфигурацию',
        'zh-Hant': '新增設定',
    },
    'settings.mcfg.count': {
        'zh': '共 {n} 条配置',
        'en': '{n} configuration(s) in total',
        'de': 'Insgesamt {n} Konfiguration(en)',
        'es': '{n} configuración(es) en total',
        'fr': '{n} configuration(s) au total',
        'ja': '合計 {n} 件の設定',
        'ko': '총 {n}개의 설정',
        'pt': '{n} configuração(ões) no total',
        'ru': 'Всего конфигураций: {n}',
        'zh-Hant': '共 {n} 組設定',
    },
    'settings.mcfg.empty': {
        'zh': '还没有任何配置。点上方「添加配置」新建一条 —— 可以先配主号，再复制一条改成备用。',
        'en': 'No configuration yet. Use "Add configuration" above to create one — you can set up a primary first, then duplicate it into a backup.',
        'de': 'Noch keine Konfiguration. Oben über „Konfiguration hinzufügen“ eine anlegen — zuerst die Hauptverbindung, dann eine Kopie als Ersatz.',
        'es': 'Todavía no hay ninguna configuración. Usa «Añadir configuración» arriba para crear una: primero la principal y luego duplicarla como alternativa.',
        'fr': 'Aucune configuration pour l’instant. Utilisez « Ajouter une configuration » ci-dessus — d’abord la principale, puis dupliquez-la en réserve.',
        'ja': 'まだ設定がありません。上の「設定を追加」で作成してください（まず本命を作り、それを複製して控えにできます）。',
        'ko': '아직 설정이 없습니다. 위의 「설정 추가」로 만드세요 — 먼저 본체를 만들고 복사해서 보관용으로 둘 수 있습니다.',
        'pt': 'Ainda não há nenhuma configuração. Use «Adicionar configuração» acima — configure primeiro a principal e duplique-a como reserva.',
        'ru': 'Конфигураций пока нет. Нажмите «Добавить конфигурацию» выше — сначала настройте основную, затем продублируйте её как запасную.',
        'zh-Hant': '尚未有任何設定。點上方「新增設定」建立一組 —— 可先設主號，再複製一組改成備用。',
    },
    'settings.mcfg.setActive': {
        'zh': '设为当前使用',
        'en': 'Set as active',
        'de': 'Als aktiv festlegen',
        'es': 'Definir como activa',
        'fr': 'Définir comme active',
        'ja': '使用中に設定',
        'ko': '사용 중으로 설정',
        'pt': 'Definir como ativa',
        'ru': 'Сделать активной',
        'zh-Hant': '設為使用中',
    },
    'settings.mcfg.active': {
        'zh': '当前使用',
        'en': 'Active',
        'de': 'Aktiv',
        'es': 'Activa',
        'fr': 'Active',
        'ja': '使用中',
        'ko': '사용 중',
        'pt': 'Ativa',
        'ru': 'Активная',
        'zh-Hant': '使用中',
    },
    'settings.mcfg.defaultName': {
        'zh': '默认配置',
        'en': 'Default configuration',
        'de': 'Standardkonfiguration',
        'es': 'Configuración predeterminada',
        'fr': 'Configuration par défaut',
        'ja': '既定の設定',
        'ko': '기본 설정',
        'pt': 'Configuração padrão',
        'ru': 'Конфигурация по умолчанию',
        'zh-Hant': '預設設定',
    },
    'settings.mcfg.noModel': {
        'zh': '未填写模型',
        'en': 'No model set',
        'de': 'Kein Modell eingetragen',
        'es': 'Sin modelo definido',
        'fr': 'Aucun modèle défini',
        'ja': 'モデル未設定',
        'ko': '모델 미설정',
        'pt': 'Sem modelo definido',
        'ru': 'Модель не указана',
        'zh-Hant': '未填寫模型',
    },
    'settings.mcfg.expand': {
        'zh': '编辑',
        'en': 'Edit',
        'de': 'Bearbeiten',
        'es': 'Editar',
        'fr': 'Modifier',
        'ja': '編集',
        'ko': '편집',
        'pt': 'Editar',
        'ru': 'Изменить',
        'zh-Hant': '編輯',
    },
    'settings.mcfg.collapse': {
        'zh': '收起',
        'en': 'Collapse',
        'de': 'Einklappen',
        'es': 'Contraer',
        'fr': 'Replier',
        'ja': '折りたたむ',
        'ko': '접기',
        'pt': 'Recolher',
        'ru': 'Свернуть',
        'zh-Hant': '收合',
    },
    'settings.mcfg.copy': {
        'zh': '复制这条配置',
        'en': 'Duplicate this configuration',
        'de': 'Diese Konfiguration kopieren',
        'es': 'Duplicar esta configuración',
        'fr': 'Dupliquer cette configuration',
        'ja': 'この設定を複製',
        'ko': '이 설정 복제',
        'pt': 'Duplicar esta configuração',
        'ru': 'Дублировать эту конфигурацию',
        'zh-Hant': '複製這組設定',
    },
    'settings.mcfg.copySuffix': {
        'zh': '副本',
        'en': 'copy',
        'de': 'Kopie',
        'es': 'copia',
        'fr': 'copie',
        'ja': 'コピー',
        'ko': '사본',
        'pt': 'cópia',
        'ru': 'копия',
        'zh-Hant': '副本',
    },
    'settings.mcfg.disabledHint': {
        'zh': '已停用：不作为推荐项；已绑定到这条配置的人物音色仍会继续使用它。',
        'en': 'Disabled: not offered as a recommendation; characters already bound to this configuration will keep using it.',
        'de': 'Deaktiviert: wird nicht mehr vorgeschlagen; bereits daran gebundene Charakterstimmen verwenden sie weiterhin.',
        'es': 'Desactivada: deja de ofrecerse como recomendada; los personajes ya vinculados a ella seguirán usándola.',
        'fr': 'Désactivée : elle n’est plus proposée ; les personnages qui y sont déjà liés continuent de l’utiliser.',
        'ja': '無効：推奨対象から外れます。この設定に紐づく人物の音声は引き続き使用されます。',
        'ko': '비활성화: 추천 항목에서 제외되며, 이 설정에 연결된 인물 음성은 계속 사용됩니다.',
        'pt': 'Desativada: deixa de ser recomendada; as personagens já vinculadas a ela continuam a usá-la.',
        'ru': 'Отключено: больше не предлагается как рекомендация; персонажи, уже привязанные к ней, продолжат её использовать.',
        'zh-Hant': '已停用：不再作為推薦項；已綁定到這組設定的人物音色仍會繼續使用它。',
    },
    # ---------- 表单字段 ----------
    'settings.mcfg.name': {
        'zh': '配置名称',
        'en': 'Configuration name',
        'de': 'Name der Konfiguration',
        'es': 'Nombre de la configuración',
        'fr': 'Nom de la configuration',
        'ja': '設定名',
        'ko': '설정 이름',
        'pt': 'Nome da configuração',
        'ru': 'Название конфигурации',
        'zh-Hant': '設定名稱',
    },
    'settings.mcfg.namePh': {
        'zh': '例如：主号 / 备用 / GPT-语音',
        'en': 'e.g. Primary / Backup / GPT Voice',
        'de': 'z. B. Haupt / Ersatz / GPT-Stimme',
        'es': 'p. ej. Principal / Alternativa / Voz GPT',
        'fr': 'ex. Principale / Secours / Voix GPT',
        'ja': '例：メイン / 予備 / GPT 音声',
        'ko': '예: 기본 / 예비 / GPT 음성',
        'pt': 'ex.: Principal / Reserva / Voz GPT',
        'ru': 'например: Основная / Резервная / Голос GPT',
        'zh-Hant': '例如：主號 / 備用 / GPT 語音',
    },
    'settings.mcfg.provider': {
        'zh': '提供商 / 协议',
        'en': 'Provider / protocol',
        'de': 'Anbieter / Protokoll',
        'es': 'Proveedor / protocolo',
        'fr': 'Fournisseur / protocole',
        'ja': 'プロバイダー / プロトコル',
        'ko': '제공자 / 프로토콜',
        'pt': 'Provedor / protocolo',
        'ru': 'Провайдер / протокол',
        'zh-Hant': '供應商 / 協定',
    },
    'settings.mcfg.providerCustom': {
        'zh': '自定义 / 按 Base URL 自动识别',
        'en': 'Custom / auto-detected from Base URL',
        'de': 'Benutzerdefiniert / automatisch aus der Base-URL',
        'es': 'Personalizado / detectado por la Base URL',
        'fr': 'Personnalisé / détecté via l’URL de base',
        'ja': 'カスタム / Base URL から自動判別',
        'ko': '사용자 지정 / Base URL에서 자동 감지',
        'pt': 'Personalizado / detectado pela Base URL',
        'ru': 'Свой / определяется по Base URL',
        'zh-Hant': '自訂 / 依 Base URL 自動判別',
    },
    'settings.mcfg.baseUrl': {
        'zh': 'Base URL',
        'en': 'Base URL',
        'de': 'Base-URL',
        'es': 'URL base',
        'fr': 'URL de base',
        'ja': 'Base URL',
        'ko': 'Base URL',
        'pt': 'URL base',
        'ru': 'Base URL',
        'zh-Hant': 'Base URL',
    },
    'settings.mcfg.model': {
        'zh': '模型',
        'en': 'Model',
        'de': 'Modell',
        'es': 'Modelo',
        'fr': 'Modèle',
        'ja': 'モデル',
        'ko': '모델',
        'pt': 'Modelo',
        'ru': 'Модель',
        'zh-Hant': '模型',
    },
    'settings.mcfg.defaultVoice': {
        'zh': '默认音色',
        'en': 'Default voice',
        'de': 'Standardstimme',
        'es': 'Voz predeterminada',
        'fr': 'Voix par défaut',
        'ja': '既定の音声',
        'ko': '기본 음성',
        'pt': 'Voz padrão',
        'ru': 'Голос по умолчанию',
        'zh-Hant': '預設音色',
    },
    'settings.mcfg.enabled': {
        'zh': '启用这条配置',
        'en': 'Enable this configuration',
        'de': 'Diese Konfiguration aktivieren',
        'es': 'Activar esta configuración',
        'fr': 'Activer cette configuration',
        'ja': 'この設定を有効にする',
        'ko': '이 설정 사용',
        'pt': 'Ativar esta configuração',
        'ru': 'Включить эту конфигурацию',
        'zh-Hant': '啟用這組設定',
    },
    'settings.mcfg.roleBindHint': {
        'zh': '人物音色可单独绑定到某一条配置；留空则跟随上面的「当前使用」。',
        'en': 'Each character voice can be bound to a specific configuration; leaving it empty follows the "Active" one above.',
        'de': 'Jede Charakterstimme kann an eine bestimmte Konfiguration gebunden werden; leer folgt sie der oben aktiven.',
        'es': 'La voz de cada personaje puede vincularse a una configuración concreta; si se deja vacío, sigue la «Activa» de arriba.',
        'fr': 'La voix de chaque personnage peut être liée à une configuration précise ; vide = suit celle « Active » ci-dessus.',
        'ja': '人物ごとの音声は特定の設定に紐づけられます。空欄なら上の「使用中」に従います。',
        'ko': '인물별 음성을 특정 설정에 연결할 수 있습니다. 비워두면 위의 「사용 중」 설정을 따릅니다.',
        'pt': 'A voz de cada personagem pode ser vinculada a uma configuração específica; vazio segue a «Ativa» acima.',
        'ru': 'Голос каждого персонажа можно привязать к конкретной конфигурации; пусто — используется «Активная» выше.',
        'zh-Hant': '人物音色可單獨綁定到某一組設定；留空則跟隨上面的「使用中」。',
    },
    # ---------- 四类服务的区块标题 ----------
    'settings.mcfg.ttsTitle': {
        'zh': '文本转语音（TTS）',
        'en': 'Text-to-speech (TTS)',
        'de': 'Sprachausgabe (TTS)',
        'es': 'Texto a voz (TTS)',
        'fr': 'Synthèse vocale (TTS)',
        'ja': '音声合成（TTS）',
        'ko': '음성 합성 (TTS)',
        'pt': 'Texto para voz (TTS)',
        'ru': 'Преобразование текста в речь (TTS)',
        'zh-Hant': '文字轉語音（TTS）',
    },
    'settings.mcfg.asrTitle': {
        'zh': '语音输入（ASR）',
        'en': 'Speech-to-text (ASR)',
        'de': 'Spracheingabe (ASR)',
        'es': 'Voz a texto (ASR)',
        'fr': 'Reconnaissance vocale (ASR)',
        'ja': '音声認識（ASR）',
        'ko': '음성 인식 (ASR)',
        'pt': 'Voz para texto (ASR)',
        'ru': 'Распознавание речи (ASR)',
        'zh-Hant': '語音輸入（ASR）',
    },
    'settings.mcfg.imageTitle': {
        'zh': '生图配置',
        'en': 'Image generation configurations',
        'de': 'Konfigurationen für Bildgenerierung',
        'es': 'Configuraciones de generación de imágenes',
        'fr': 'Configurations de génération d’images',
        'ja': '画像生成の設定',
        'ko': '이미지 생성 설정',
        'pt': 'Configurações de geração de imagens',
        'ru': 'Настройки генерации изображений',
        'zh-Hant': '生圖設定',
    },
    'settings.mcfg.videoTitle': {
        'zh': '生视频配置',
        'en': 'Video generation configurations',
        'de': 'Konfigurationen für Videogenerierung',
        'es': 'Configuraciones de generación de vídeo',
        'fr': 'Configurations de génération de vidéo',
        'ja': '動画生成の設定',
        'ko': '동영상 생성 설정',
        'pt': 'Configurações de geração de vídeo',
        'ru': 'Настройки генерации видео',
        'zh-Hant': '生影片設定',
    },
    'settings.mcfg.asrModelPh': {
        'zh': '例如 whisper-1',
        'en': 'e.g. whisper-1',
        'de': 'z. B. whisper-1',
        'es': 'p. ej. whisper-1',
        'fr': 'ex. whisper-1',
        'ja': '例：whisper-1',
        'ko': '예: whisper-1',
        'pt': 'ex.: whisper-1',
        'ru': 'например whisper-1',
        'zh-Hant': '例如 whisper-1',
    },
    'settings.mcfg.ttsPlayTitle': {
        'zh': '朗读行为（全局）',
        'en': 'Speech playback (global)',
        'de': 'Sprachwiedergabe (global)',
        'es': 'Reproducción de voz (global)',
        'fr': 'Lecture vocale (global)',
        'ja': '読み上げの動作（全体）',
        'ko': '읽기 동작 (전역)',
        'pt': 'Reprodução de voz (global)',
        'ru': 'Произношение (глобально)',
        'zh-Hant': '朗讀行為（全域）',
    },
    'settings.mcfg.ttsPlayDesc': {
        'zh': '以下开关对所有 TTS 配置统一生效。语速与音调按各厂商协议的原生参数下发，仅对协议本身支持的提供商生效。',
        'en': 'These switches apply to all TTS configurations. Speed and pitch are sent as each vendor’s native parameters, so they only take effect for providers whose protocol supports them.',
        'de': 'Diese Schalter gelten für alle TTS-Konfigurationen. Geschwindigkeit und Tonhöhe werden als native Herstellerparameter gesendet und wirken nur bei Anbietern, deren Protokoll sie unterstützt.',
        'es': 'Estos interruptores se aplican a todas las configuraciones de TTS. La velocidad y el tono se envían como parámetros nativos de cada proveedor y solo surten efecto en los que los admiten.',
        'fr': 'Ces interrupteurs s’appliquent à toutes les configurations TTS. La vitesse et la tonalité sont envoyées comme paramètres natifs du fournisseur : elles n’agissent que sur les protocoles qui les prennent en charge.',
        'ja': '以下のスイッチはすべての TTS 設定に共通して効きます。話速とピッチは各社のネイティブパラメータとして送信されるため、対応しているプロバイダでのみ反映されます。',
        'ko': '아래 스위치는 모든 TTS 설정에 공통으로 적용됩니다. 말하기 속도와 높이는 각 업체의 네이티브 매개변수로 전달되므로 해당 프로토콜을 지원하는 제공자에서만 반영됩니다.',
        'pt': 'Estes interruptores valem para todas as configurações de TTS. Velocidade e tom são enviados como parâmetros nativos de cada fornecedor e só têm efeito nos que os suportam.',
        'ru': 'Эти переключатели действуют для всех конфигураций TTS. Скорость и высота тона отправляются как штатные параметры провайдера и срабатывают только у тех, чей протокол их поддерживает.',
        'zh-Hant': '以下開關對所有 TTS 設定統一生效。語速與音調依各廠商協定的原生參數下發，僅對協定本身支援的供應商生效。',
    },
    'settings.mcfg.noActiveTts': {
        'zh': '还没有可用的 TTS 配置：请先在上方填好 Base URL、API Key 与模型。',
        'en': 'No usable TTS configuration yet: fill in the Base URL, API key and model above first.',
        'de': 'Noch keine nutzbare TTS-Konfiguration: Bitte zuerst Base-URL, API-Schlüssel und Modell oben ausfüllen.',
        'es': 'Aún no hay ninguna configuración de TTS utilizable: rellena antes la URL base, la clave de API y el modelo.',
        'fr': 'Aucune configuration TTS utilisable pour l’instant : renseignez d’abord l’URL de base, la clé API et le modèle ci-dessus.',
        'ja': '使える TTS 設定がまだありません：先に上の Base URL・API キー・モデルを入力してください。',
        'ko': '사용 가능한 TTS 설정이 아직 없습니다: 먼저 위의 Base URL, API 키, 모델을 입력하세요.',
        'pt': 'Ainda não há nenhuma configuração de TTS utilizável: preencha primeiro a URL base, a chave de API e o modelo acima.',
        'ru': 'Пригодной конфигурации TTS пока нет: сначала заполните Base URL, ключ API и модель выше.',
        'zh-Hant': '尚無可用的 TTS 設定：請先在上方填好 Base URL、API Key 與模型。',
    },
    # ---------- 人物音色绑定 ----------
    'settings.mcfg.roleBindTitle': {
        'zh': '该人物使用哪条 TTS 配置',
        'en': 'Which TTS configuration this character uses',
        'de': 'Welche TTS-Konfiguration diese Figur verwendet',
        'es': 'Qué configuración de TTS usa este personaje',
        'fr': 'Quelle configuration TTS utilise ce personnage',
        'ja': 'この人物が使う TTS 設定',
        'ko': '이 인물이 사용할 TTS 설정',
        'pt': 'Qual configuração de TTS este personagem usa',
        'ru': 'Какую конфигурацию TTS использует этот персонаж',
        'zh-Hant': '該人物使用哪一組 TTS 設定',
    },
    'settings.mcfg.roleBindAuto': {
        'zh': '跟随当前使用',
        'en': 'Follow the active one',
        'de': 'Der aktiven folgen',
        'es': 'Seguir la activa',
        'fr': 'Suivre la configuration active',
        'ja': '使用中の設定に従う',
        'ko': '사용 중인 설정 따르기',
        'pt': 'Seguir a ativa',
        'ru': 'Следовать активной',
        'zh-Hant': '跟隨使用中',
    },
    # ---------- 跳转卡片（生成分类内）----------
    'settings.mcfgMovedTitle': {
        'zh': 'TTS / 语音输入 / 生图 / 生视频的 API 配置',
        'en': 'TTS / speech-to-text / image / video API configurations',
        'de': 'TTS-/Spracheingabe-/Bild-/Video-API-Konfigurationen',
        'es': 'Configuraciones de API de TTS / voz a texto / imagen / vídeo',
        'fr': 'Configurations d’API TTS / reconnaissance vocale / image / vidéo',
        'ja': 'TTS・音声認識・画像生成・動画生成の API 設定',
        'ko': 'TTS / 음성 인식 / 이미지 / 동영상 API 설정',
        'pt': 'Configurações de API de TTS / voz-para-texto / imagem / vídeo',
        'ru': 'Настройки API для TTS / распознавания речи / изображений / видео',
        'zh-Hant': 'TTS / 語音輸入 / 生圖 / 生影片的 API 設定',
    },
    'settings.mcfgMovedDesc': {
        'zh': 'v2.3.94 起，这四类服务的配置已移入「模型管理」页，与文本模型一样支持添加多条配置、标记当前使用项并随时切换。',
        'en': 'As of v2.3.94 these four services live in “Model management”, where — just like text models — you can add several configurations, mark one as active and switch at any time.',
        'de': 'Seit v2.3.94 liegen diese vier Dienste unter „ Modellverwaltung“ — wie bei Textmodellen kannst du mehrere Konfigurationen anlegen, eine als aktiv markieren und jederzeit wechseln.',
        'es': 'Desde la v2.3.94 estos cuatro servicios están en «Gestión de modelos»: como con los modelos de texto, puedes añadir varias configuraciones, marcar una como activa y cambiar cuando quieras.',
        'fr': 'Depuis la v2.3.94, ces quatre services se trouvent dans « Gestion des modèles » : comme pour les modèles de texte, vous pouvez ajouter plusieurs configurations, en marquer une active et changer à tout moment.',
        'ja': 'v2.3.94 から、この4 つのサービスの設定は「モデル管理」に移りました。テキストモデルと同じく複数追加し、使用中を選んでいつでも切り替えられます。',
        'ko': 'v2.3.94부터 이 네 가지 서비스 설정은 「모델 관리」로 옮겨졌습니다. 텍스트 모델과 마찬가지로 여러 개를 추가하고 사용 중인 항목을 골라 언제든 전환할 수 있습니다.',
        'pt': 'Desde a v2.3.94 estes quatro serviços estão em “Gerenciamento de modelos”: como nos modelos de texto, você pode adicionar várias configurações, marcar uma como ativa e trocar quando quiser.',
        'ru': 'С версии 2.3.94 эти четыре сервиса находятся в разделе «Управление моделями»: как и для текстовых моделей, можно добавить несколько конфигураций, отметить активную и переключаться в любой момент.',
        'zh-Hant': '自 v2.3.94 起，這四類服務的設定已移入「模型管理」頁，與文字模型一樣可新增多組設定、標記使用中項並隨時切換。',
    },
    'settings.mcfgMovedEnter': {
        'zh': '点击前往「模型管理」',
        'en': 'Click to open “Model management”',
        'de': 'Klicken, um „Modellverwaltung“ zu öffnen',
        'es': 'Haz clic para abrir «Gestión de modelos»',
        'fr': 'Cliquez pour ouvrir « Gestion des modèles »',
        'ja': 'クリックして「モデル管理」を開く',
        'ko': '클릭하여 「모델 관리」 열기',
        'pt': 'Clique para abrir “Gerenciamento de modelos”',
        'ru': 'Нажмите, чтобы открыть «Управление моделями»',
        'zh-Hant': '點擊前往「模型管理」',
    },
}

# =====translations.ts：zh / en 两段就地插入 =====
def patch_translations():
    with io.open(TRANSLATIONS, 'r', encoding='utf-8') as f:
        src = f.read()
    i = src.index("  zh: {")
    j = src.index("\n  en: {")
    end = src.rindex("\n};")
    head, zh_seg, en_seg, tail = src[:i], src[i:j], src[j:end], src[end:]

    inserted = 0
    for seg_name, seg in (('zh', zh_seg), ('en', en_seg)):
        lang = 'zh' if seg_name == 'zh' else 'en'
        lines = seg.split('\n')
        anchor_idx = None
        for idx, ln in enumerate(lines):
            if ("'%s':" % ANCHOR) in ln:
                anchor_idx = idx
                break
        if anchor_idx is None:
            raise SystemExit('anchor %s not found in %s segment' % (ANCHOR, seg_name))
        block = []
        for key in NEW:
            text = NEW[key][lang]
            block.append("    '%s': '%s'," % (key, text.replace("'", "\\'")))
        lines[anchor_idx + 1:anchor_idx + 1] = block
        inserted += len(block)
        if seg_name == 'zh':
            zh_seg = '\n'.join(lines)
        else:
            en_seg = '\n'.join(lines)

    with io.open(TRANSLATIONS, 'w', encoding='utf-8') as f:
        f.write(head + zh_seg + en_seg + tail)
    return inserted


# ===== locales/ 下 8 个 JSON：插到锚点之后（幂等）=====
def patch_locale(path, lang):
    with io.open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if ANCHOR not in data:
        raise SystemExit('anchor %s missing in %s' % (ANCHOR, path))
    new_keys = [k for k in NEW if k not in data or True]
    before = len(data)
    for k in new_keys:
        data[k] = NEW[k][lang]
    order = list(data.keys())
    order = [k for k in order if k not in NEW]
    idx = order.index(ANCHOR) + 1
    for offset, k in enumerate(new_keys):
        order.insert(idx + offset, k)
    ordered = {k: data[k] for k in order}
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(ordered, ensure_ascii=False, indent=2))
        f.write('\n')
    return before, len(ordered)


def main():
    n = patch_translations()
    print('translations.ts: inserted %d lines (zh + en)' % n)
    for lang in ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']:
        path = os.path.join(LOCALES, '%s.json' % lang)
        if not os.path.exists(path):
            print('SKIP (missing) %s' % path)
            continue
        before, after = patch_locale(path, lang)
        print('%-8s %4d -> %4d keys  (+%d)' % (lang, before, after, after - before))
    return 0


if __name__ == '__main__':
    sys.exit(main())