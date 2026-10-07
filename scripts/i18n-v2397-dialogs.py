#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v2.3.97 · 把「自绘弹窗」新增文案同步进 8 个语言包（locales/*.json）

用法：python scripts/i18n-v2397-dialogs.py

## 为什么需要这个脚本（一次真实的踩坑记录）

项目里有好几位工程师并行改`src/i18n/locales/*.json`。有一次我写完键、跑完校验，
十分钟后回来一看**键全没了** —— 另一位工程师用他自己那份（更早的）translations.ts
重新生成了8 个语言包，把我新增的 30+ 个键整体覆盖掉了，而 `git diff` 看上去
「只有 33 行变化」，完全不像丢了 30 个键那么显眼。

于是定下这条规矩：
  - **`src/i18n/translations.ts` 是唯一真源**（zh/en 内置其中）；
  - **`locales/*.json` 是生成物**，任何人都可能重写；
  - 所以「补键」这件事必须**可重复执行**，并且要能**一键检出「真源有、生成物缺」**。

本脚本因此不是「一次性补键工具」，而是**幂等的同步 + 校验工具**：
重复跑不会产生重复键；跑完会断言真源里的每个弹窗键在 8 个语言里都存在。
若别人再次覆盖了语言包，重跑本脚本即可复原。

## 用法约定

- 新增键：先加进 `translations.ts`（zh + en 两段），再填下面TRANSLATIONS 里
  8 个语言的译文，最后跑一次本脚本 + `node scripts/verify-no-native-dialog.mjs`。
- 别人覆盖了语言包：直接重跑本脚本即可复原（不必手改JSON）。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_DIR = os.path.join(ROOT, 'src', 'i18n', 'locales')
TS_PATH = os.path.join(ROOT, 'src', 'i18n', 'translations.ts')

LANGS = ['ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'zh-Hant']

# 本任务新增的全部键（弹窗相关），用于校验「真源 ↔ 语言包」是否同步
DIALOG_KEYS = [
    # 确认框
    'confirm.title', 'confirm.ok', 'confirm.cancel',
    # 文件选择器 · 基础
    'filepicker.title', 'filepicker.places', 'filepicker.list',
    'filepicker.groupDirs', 'filepicker.groupFiles', 'filepicker.parent',
    'filepicker.loading', 'filepicker.empty', 'filepicker.fileName',
    'filepicker.selected', 'filepicker.errTraversal', 'filepicker.errRead',
    # 文件选择器 · 位置栏
    'filepicker.place.data', 'filepicker.place.documents', 'filepicker.place.downloads',
    'filepicker.place.desktop', 'filepicker.place.pictures',
    'filepicker.place.home', 'filepicker.place.root',
    # 文件选择器 · 新建文件夹
    'filepicker.newFolder', 'filepicker.newFolderName', 'filepicker.create',
    'filepicker.mkdirExists', 'filepicker.mkdirInvalidName',
    'filepicker.mkdirPermission', 'filepicker.mkdirNotDir', 'filepicker.mkdirFailed',
    # 选图引导弹窗
    'imagepick.browse', 'imagepick.guideDesc', 'imagepick.dropHint',
]

TRANSLATIONS = {
    'ja': {
        'confirm.title': '確認', 'confirm.ok': '確定', 'confirm.cancel': 'キャンセル',
        'filepicker.title': 'ファイルを選択', 'filepicker.places': '場所',
        'filepicker.list': 'ファイル一覧', 'filepicker.groupDirs': 'フォルダー',
        'filepicker.groupFiles': 'ファイル', 'filepicker.parent': '上へ',
        'filepicker.loading': '読み込み中…', 'filepicker.empty': 'このフォルダーは空です',
        'filepicker.fileName': 'ファイル名', 'filepicker.selected': '{n} 件選択中',
        'filepicker.errTraversal': '「..」で上のフォルダーに移動することはできません。「上へ」ボタンを使ってください。',
        'filepicker.errRead': 'このフォルダーを読み取れません（権限がない、または存在しません）。上へ移動して別の場所を選んでください。',
        'filepicker.place.data': '念語データフォルダ', 'filepicker.place.documents': 'ドキュメント',
        'filepicker.place.downloads': 'ダウンロード', 'filepicker.place.desktop': 'デスクトップ',
        'filepicker.place.pictures': 'ピクチャ', 'filepicker.place.home': 'ホーム',
        'filepicker.place.root': 'コンピューター',
        'filepicker.newFolder': '新規フォルダ', 'filepicker.newFolderName': '新しいフォルダ名',
        'filepicker.create': '作成', 'filepicker.mkdirExists': '同名のフォルダが既に存在します',
        'filepicker.mkdirInvalidName': 'このフォルダ名は使用できません（/ \\ : * ? " < > | や予約語は使えません）',
        'filepicker.mkdirPermission': '権限がありません',
        'filepicker.mkdirNotDir': 'この場所にはフォルダを作成できません',
        'filepicker.mkdirFailed': 'フォルダを作成できませんでした',
        'imagepick.browse': 'ファイルを選択',
        'imagepick.guideDesc': '本地画像ファイルを選ぶには、下の「ファイルを選択」をクリックしてください。',
        'imagepick.dropHint': 'ここに画像をドラッグ＆ドロップしても選べます',
    },
    'ko': {
        'confirm.title': '확인', 'confirm.ok': '확인', 'confirm.cancel': '취소',
        'filepicker.title': '파일 선택', 'filepicker.places': '위치',
        'filepicker.list': '파일 목록', 'filepicker.groupDirs': '폴더',
        'filepicker.groupFiles': '파일', 'filepicker.parent': '상위',
        'filepicker.loading': '불러오는 중…', 'filepicker.empty': '이 폴더는 비어 있습니다',
        'filepicker.fileName': '파일 이름', 'filepicker.selected': '{n}개 선택됨',
        'filepicker.errTraversal': '".."로 상위 폴더에 접근할 수 없습니다. "상위" 버튼을 사용하세요.',
        'filepicker.errRead': '이 폴더를 읽을 수 없습니다(권한 없음 또는 이미 삭제됨). 상위로 이동해 다른 위치를 선택하세요.',
        'filepicker.place.data': '냥위 데이터 폴더', 'filepicker.place.documents': '문서',
        'filepicker.place.downloads': '다운로드', 'filepicker.place.desktop': '바탕화면',
        'filepicker.place.pictures': '그림', 'filepicker.place.home': '홈',
        'filepicker.place.root': '이 PC',
        'filepicker.newFolder': '새 폴더', 'filepicker.newFolderName': '새 폴더 이름',
        'filepicker.create': '만들기', 'filepicker.mkdirExists': '같은 이름의 폴더가 이미 있습니다',
        'filepicker.mkdirInvalidName': '사용할 수 없는 폴더 이름입니다 (/ \\ : * ? " < > | 및 예약어 사용 불가)',
        'filepicker.mkdirPermission': '권한이 없습니다',
        'filepicker.mkdirNotDir': '이 위치에는 폴더를 만들 수 없습니다',
        'filepicker.mkdirFailed': '폴더를 만들지 못했습니다',
        'imagepick.browse': '파일 선택',
        'imagepick.guideDesc': '로컬 이미지 파일을 선택하려면 아래의 「파일 선택」 을 클릭하세요.',
        'imagepick.dropHint': '여기에 이미지를 끌어다 놓아도 선택할 수 있습니다',
    },
    'fr': {
        'confirm.title': 'Confirmation', 'confirm.ok': 'Confirmer', 'confirm.cancel': 'Annuler',
        'filepicker.title': 'Sélectionner un fichier', 'filepicker.places': 'Emplacements',
        'filepicker.list': 'Liste des fichiers', 'filepicker.groupDirs': 'Dossiers',
        'filepicker.groupFiles': 'Fichiers', 'filepicker.parent': 'Dossier parent',
        'filepicker.loading': 'Chargement…', 'filepicker.empty': 'Ce dossier est vide',
        'filepicker.fileName': 'Nom du fichier', 'filepicker.selected': '{n} sélectionné(s)',
        'filepicker.errTraversal': 'Impossible d\'utiliser « .. » pour remonter. Utilisez plutôt le bouton « Dossier parent ».',
        'filepicker.errRead': 'Impossible de lire ce dossier (autorisation refusée ou dossier introuvable). Remontez et choisissez un autre emplacement.',
        'filepicker.place.data': 'Dossier de données Nianyu', 'filepicker.place.documents': 'Documents',
        'filepicker.place.downloads': 'Téléchargements', 'filepicker.place.desktop': 'Bureau',
        'filepicker.place.pictures': 'Images', 'filepicker.place.home': 'Dossier personnel',
        'filepicker.place.root': 'Ce PC',
        'filepicker.newFolder': 'Nouveau dossier', 'filepicker.newFolderName': 'Nom du nouveau dossier',
        'filepicker.create': 'Créer', 'filepicker.mkdirExists': 'Un dossier portant ce nom existe déjà',
        'filepicker.mkdirInvalidName': 'Ce nom de dossier est invalide (/ \\ : * ? " < > | et noms réservés sont refusés)',
        'filepicker.mkdirPermission': 'Permission refusée',
        'filepicker.mkdirNotDir': 'Impossible de créer un dossier à cet emplacement',
        'filepicker.mkdirFailed': 'Échec de la création du dossier',
        'imagepick.browse': 'Parcourir…',
        'imagepick.guideDesc': 'Pour choisir une image locale, cliquez sur « Parcourir… ».',
        'imagepick.dropHint': 'Vous pouvez aussi déposer une image ici',
    },
    'de': {
        'confirm.title': 'Bestätigung', 'confirm.ok': 'Bestätigen', 'confirm.cancel': 'Abbrechen',
        'filepicker.title': 'Datei auswählen', 'filepicker.places': 'Orte',
        'filepicker.list': 'Dateiliste', 'filepicker.groupDirs': 'Ordner',
        'filepicker.groupFiles': 'Dateien', 'filepicker.parent': 'Übergeordneter Ordner',
        'filepicker.loading': 'Wird geladen…', 'filepicker.empty': 'Dieser Ordner ist leer',
        'filepicker.fileName': 'Dateiname', 'filepicker.selected': '{n} ausgewählt',
        'filepicker.errTraversal': '„..“ kann nicht zum übergeordneten Ordner führen. Bitte die Schaltfläche „Übergeordneter Ordner“ verwenden.',
        'filepicker.errRead': 'Dieser Ordner kann nicht gelesen werden (keine Berechtigung oder nicht mehr vorhanden). Bitte eine Ebene höher gehen und einen anderen Ort wählen.',
        'filepicker.place.data': 'Nianyu-Datenordner', 'filepicker.place.documents': 'Dokumente',
        'filepicker.place.downloads': 'Downloads', 'filepicker.place.desktop': 'Desktop',
        'filepicker.place.pictures': 'Bilder', 'filepicker.place.home': 'Benutzerordner',
        'filepicker.place.root': 'Dieser PC',
        'filepicker.newFolder': 'Neuer Ordner', 'filepicker.newFolderName': 'Name des neuen Ordners',
        'filepicker.create': 'Erstellen', 'filepicker.mkdirExists': 'Ein Ordner mit diesem Namen existiert bereits',
        'filepicker.mkdirInvalidName': 'Ungültiger Ordnername (/ \\ : * ? " < > | und reservierte Namen sind nicht erlaubt)',
        'filepicker.mkdirPermission': 'Keine Berechtigung',
        'filepicker.mkdirNotDir': 'An diesem Ort kann kein Ordner erstellt werden',
        'filepicker.mkdirFailed': 'Ordner konnte nicht erstellt werden',
        'imagepick.browse': 'Durchsuchen…',
        'imagepick.guideDesc': 'Klicke auf „Durchsuchen…“, um ein lokales Bild auszuwählen.',
        'imagepick.dropHint': 'Du kannst ein Bild auch hierher ziehen',
    },
    'es': {
        'confirm.title': 'Confirmación', 'confirm.ok': 'Confirmar', 'confirm.cancel': 'Cancelar',
        'filepicker.title': 'Seleccionar archivo', 'filepicker.places': 'Ubicaciones',
        'filepicker.list': 'Lista de archivos', 'filepicker.groupDirs': 'Carpetas',
        'filepicker.groupFiles': 'Archivos', 'filepicker.parent': 'Carpeta superior',
        'filepicker.loading': 'Cargando…', 'filepicker.empty': 'Esta carpeta está vacía',
        'filepicker.fileName': 'Nombre del archivo', 'filepicker.selected': '{n} seleccionado(s)',
        'filepicker.errTraversal': 'No se puede usar «..» para subir. Usa el botón «Carpeta superior».',
        'filepicker.errRead': 'No se puede leer esta carpeta (sin permiso o ya no existe). Sube y elige otra ubicación.',
        'filepicker.place.data': 'Carpeta de datos de Nianyu', 'filepicker.place.documents': 'Documentos',
        'filepicker.place.downloads': 'Descargas', 'filepicker.place.desktop': 'Escritorio',
        'filepicker.place.pictures': 'Imágenes', 'filepicker.place.home': 'Carpeta personal',
        'filepicker.place.root': 'Este equipo',
        'filepicker.newFolder': 'Nueva carpeta', 'filepicker.newFolderName': 'Nombre de la nueva carpeta',
        'filepicker.create': 'Crear', 'filepicker.mkdirExists': 'Ya existe una carpeta con ese nombre',
        'filepicker.mkdirInvalidName': 'Nombre de carpeta no válido (no se admiten / \\ : * ? " < > | ni nombres reservados)',
        'filepicker.mkdirPermission': 'Sin permiso',
        'filepicker.mkdirNotDir': 'No se puede crear una carpeta en esta ubicación',
        'filepicker.mkdirFailed': 'No se pudo crear la carpeta',
        'imagepick.browse': 'Examinar…',
        'imagepick.guideDesc': 'Para elegir una imagen local, haz clic en «Examinar…».',
        'imagepick.dropHint': 'También puedes arrastrar una imagen aquí',
    },
    'pt': {
        'confirm.title': 'Confirmação', 'confirm.ok': 'Confirmar', 'confirm.cancel': 'Cancelar',
        'filepicker.title': 'Selecionar ficheiro', 'filepicker.places': 'Locais',
        'filepicker.list': 'Lista de ficheiros', 'filepicker.groupDirs': 'Pastas',
        'filepicker.groupFiles': 'Ficheiros', 'filepicker.parent': 'Pasta superior',
        'filepicker.loading': 'A carregar…', 'filepicker.empty': 'Esta pasta está vazia',
        'filepicker.fileName': 'Nome do ficheiro', 'filepicker.selected': '{n} selecionado(s)',
        'filepicker.errTraversal': 'Não é possível usar «..» para subir. Use o botão «Pasta superior».',
        'filepicker.errRead': 'Não é possível ler esta pasta (sem permissão ou já não existe). Suba e escolha outro local.',
        'filepicker.place.data': 'Pasta de dados do Nianyu', 'filepicker.place.documents': 'Documentos',
        'filepicker.place.downloads': 'Transferências', 'filepicker.place.desktop': 'Área de Trabalho',
        'filepicker.place.pictures': 'Imagens', 'filepicker.place.home': 'Pasta pessoal',
        'filepicker.place.root': 'Este PC',
        'filepicker.newFolder': 'Nova pasta', 'filepicker.newFolderName': 'Nome da nova pasta',
        'filepicker.create': 'Criar', 'filepicker.mkdirExists': 'Já existe uma pasta com esse nome',
        'filepicker.mkdirInvalidName': 'Nome de pasta inválido (/ \\ : * ? " < > | e nomes reservados não são permitidos)',
        'filepicker.mkdirPermission': 'Sem permissão',
        'filepicker.mkdirNotDir': 'Não é possível criar uma pasta neste local',
        'filepicker.mkdirFailed': 'Não foi possível criar a pasta',
        'imagepick.browse': 'Procurar…',
        'imagepick.guideDesc': 'Para escolher uma imagem local, clique em «Procurar…».',
        'imagepick.dropHint': 'Também pode arrastar uma imagem para aqui',
    },
    'ru': {
        'confirm.title': 'Подтверждение', 'confirm.ok': 'Подтвердить', 'confirm.cancel': 'Отмена',
        'filepicker.title': 'Выбор файла', 'filepicker.places': 'Места',
        'filepicker.list': 'Список файлов', 'filepicker.groupDirs': 'Папки',
        'filepicker.groupFiles': 'Файлы', 'filepicker.parent': 'Вверх',
        'filepicker.loading': 'Загрузка…', 'filepicker.empty': 'Эта папка пуста',
        'filepicker.fileName': 'Имя файла', 'filepicker.selected': 'Выбрано: {n}',
        'filepicker.errTraversal': 'Использовать «..» для перехода вверх нельзя. Нажмите кнопку «Вверх».',
        'filepicker.errRead': 'Не удалось прочитать эту папку (нет прав доступа или она больше не существует). Поднимитесь выше и выберите другое расположение.',
        'filepicker.place.data': 'Папка данных Nianyu', 'filepicker.place.documents': 'Документы',
        'filepicker.place.downloads': 'Загрузки', 'filepicker.place.desktop': 'Рабочий стол',
        'filepicker.place.pictures': 'Изображения', 'filepicker.place.home': 'Домашняя папка',
        'filepicker.place.root': 'Этот компьютер',
        'filepicker.newFolder': 'Новая папка', 'filepicker.newFolderName': 'Имя новой папки',
        'filepicker.create': 'Создать', 'filepicker.mkdirExists': 'Папка с таким именем уже существует',
        'filepicker.mkdirInvalidName': 'Недопустимое имя папки (нельзя использовать / \\ : * ? " < > | и зарезервированные имена)',
        'filepicker.mkdirPermission': 'Нет прав доступа',
        'filepicker.mkdirNotDir': 'В этом месте нельзя создать папку',
        'filepicker.mkdirFailed': 'Не удалось создать папку',
        'imagepick.browse': 'Обзор…',
        'imagepick.guideDesc': 'Чтобы выбрать локальное изображение, нажмите «Обзор…».',
        'imagepick.dropHint': 'Изображение также можно перетащить сюда',
    },
    'zh-Hant': {
        'confirm.title': '確認', 'confirm.ok': '確定', 'confirm.cancel': '取消',
        'filepicker.title': '選擇檔案', 'filepicker.places': '位置',
        'filepicker.list': '檔案清單', 'filepicker.groupDirs': '資料夾',
        'filepicker.groupFiles': '檔案', 'filepicker.parent': '上層',
        'filepicker.loading': '載入中…', 'filepicker.empty': '此資料夾是空的',
        'filepicker.fileName': '檔案名稱', 'filepicker.selected': '已選 {n} 個',
        'filepicker.errTraversal': '不允許用「..」存取上層目錄，請改用「上層」按鈕。',
        'filepicker.errRead': '無法讀取此資料夾（可能沒有權限或已不存在），請返回上層改選其他位置。',
        'filepicker.place.data': '念語資料目錄', 'filepicker.place.documents': '文件',
        'filepicker.place.downloads': '下載', 'filepicker.place.desktop': '桌面',
        'filepicker.place.pictures': '圖片', 'filepicker.place.home': '主目錄',
        'filepicker.place.root': '這部電腦',
        'filepicker.newFolder': '新增資料夾', 'filepicker.newFolderName': '新資料夾名稱',
        'filepicker.create': '建立', 'filepicker.mkdirExists': '已存在同名資料夾',
        'filepicker.mkdirInvalidName': '無效的資料夾名稱（不可含 / \\ : * ? " < > | 或系統保留字）',
        'filepicker.mkdirPermission': '沒有權限',
        'filepicker.mkdirNotDir': '無法在此位置建立資料夾',
        'filepicker.mkdirFailed': '無法建立資料夾',
        'imagepick.browse': '選擇檔案…',
        'imagepick.guideDesc': '要選擇本機圖片，請點擊下方的「選擇檔案…」。',
        'imagepick.dropHint': '也可以把圖片拖放到這裡',
    },
}


def main() -> int:
    # ---- 第1 步：确认真源里有这些键（否则说明 translations.ts 忘了加）----
    ts = open(TS_PATH, encoding='utf-8').read()
    missing_in_source = [k for k in DIALOG_KEYS if ts.count(f"'{k}'") < 2]
    if missing_in_source:
        print('  FAIL  translations.ts 缺少以下键（zh/en 各需一次）：')
        for k in missing_in_source:
            print('        - ' + k)
        return 1
    print(f'  PASS  translations.ts 真源含全部 {len(DIALOG_KEYS)} 个键（zh + en）')

    # ---- 第 2 步：幂等写入 8 个语言包 ----
    added_total = 0
    for lang in LANGS:
        pairs = TRANSLATIONS[lang]
        # 自检：译文表的键必须与 DIALOG_KEYS 完全一致，防止两处不同步
        if set(pairs.keys()) != set(DIALOG_KEYS):
            only_tbl = set(pairs) - set(DIALOG_KEYS)
            only_decl = set(DIALOG_KEYS) - set(pairs)
            print(f'  FAIL  {lang} 译文表键集与 DIALOG_KEYS 不一致'
                  f'（多：{sorted(only_tbl)} 缺：{sorted(only_decl)}）')
            return 1
        p = os.path.join(LOCALES_DIR, f'{lang}.json')
        with open(p, 'r', encoding='utf-8') as f:
            data = json.load(f)
        added = 0
        for key, value in pairs.items():
            if key not in data:
                data[key] = value
                added += 1
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
            f.write('\n')
        added_total += added
        print(f'  {"PASS" if added else "SKIP"}  {lang}: 写入 {added} 键，共 {len(data)} 键')

    # ---- 第 3 步：回读校验（防止「写完即忘」，也防止被别人再次覆盖）----
    print(f'\n回读校验 {len(DIALOG_KEYS)} 个键 × {len(LANGS)} 个语言包：')
    problems = []
    for lang in LANGS:
        p = os.path.join(LOCALES_DIR, f'{lang}.json')
        with open(p, 'r', encoding='utf-8') as f:
            data = json.load(f)
        miss = [k for k in DIALOG_KEYS if k not in data]
        empty = [k for k in DIALOG_KEYS if k in data and not str(data[k]).strip()]
        if miss:
            problems.append(f'{lang}.json 缺 {len(miss)} 键：{miss[:5]}...')
        if empty:
            problems.append(f'{lang}.json 有 {len(empty)} 个空值：{empty[:5]}...')
    if problems:
        for pr in problems:
            print('  FAIL  ' + pr)
        return 1
    print(f'  PASS  全部 {len(DIALOG_KEYS)} 键在 {len(LANGS)} 个语言包中齐全且非空')
    print(f'\n完成：本次写入 {added_total} 条译文（0 表示语言包本来就是最新的）')
    return 0


if __name__ == '__main__':
    sys.exit(main())