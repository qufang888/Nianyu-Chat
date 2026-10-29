#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一次性脚本：把「动态光标重做（v2.3.126）」相关的新增/更新 i18n 键同步到
translations.ts（zh / en 内联块）与 8 个 locale JSON。

用法：python scripts/i18n-v2326-cursor.py
"""
import io
import json
import os
import re
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# 键 → 各语言译文
# ---------------------------------------------------------------------------
T = collections.OrderedDict()

T['settings.cursorDesc'] = {
    'zh': '用 DOM 字形 + Canvas 特效渲染动态光标：字形始终精确跟随指针（显示位置＝点击位置），配合拖尾与粒子拖动特效。可上传自定义图片替换默认光标。',
    'en': 'Dynamic cursor rendered with a DOM glyph + Canvas effects: the glyph follows the pointer exactly (what you see is where you click), with a trail and drag-out particle effect. Upload your own image to replace the default cursor.',
    'de': 'Dynamischer Cursor mit DOM-Glyphe + Canvas-Effekten: Die Glyphe folgt dem Zeiger exakt (Anzeige = Klickpunkt), mit Spur und herausgeschleuderten Partikeln. Laden Sie ein eigenes Bild hoch, um den Standardcursor zu ersetzen.',
    'es': 'Cursor dinámico con glifo DOM + efectos Canvas: el glifo sigue al puntero con exactitud (lo que ves es donde haces clic), con estela y partículas que salen disparadas. Sube tu propia imagen para sustituir el cursor predeterminado.',
    'fr': "Curseur dynamique avec glyphe DOM + effets Canvas : le glyphe suit exactement le pointeur (ce que vous voyez est l'endroit où vous cliquez), avec traînée et particules projetées. Importez votre propre image pour remplacer le curseur par défaut.",
    'ja': 'DOM グリフ + Canvas エフェクトで描画する動的カーソル。グリフはポインタに厳密に追従し（見える位置＝クリック位置）、軌跡と飛ばされる粒子の効果付き。独自の画像をアップロードして既定カーソルを差し替えられます。',
    'ko': 'DOM 글리프 + Canvas 효과로 렌더링하는 동적 커서. 글리프는 포인터를 정확히 따라가며(보이는 위치＝클릭 위치), 잔상과 튕겨 나가는 파티클 효과가 적용됩니다. 직접 이미지를 업로드해 기본 커서를 교체할 수 있습니다.',
    'pt': 'Cursor dinâmico com glifo DOM + efeitos Canvas: o glifo segue o ponteiro com precisão (o que você vê é onde clica), com rastro e partículas arremessadas. Envie sua própria imagem para substituir o cursor padrão.',
    'ru': 'Динамический курсор: глиф DOM + эффекты Canvas. Глиф точно следует за указателем (видимое место = место клика), с хвостом и разлетающимися частицами. Загрузите своё изображение вместо курсора по умолчанию.',
    'zh-Hant': '以 DOM 字形 + Canvas 特效繪製動態游標：字形始終精確跟隨指標（顯示位置＝點擊位置），並帶有拖尾與粒子甩出效果。可上傳自訂圖片取代預設游標。',
}

T['settings.cursorLerpSpeedDesc'] = {
    'zh': '光标字形本身始终精确跟随指针（显示位置＝点击位置），此项只影响拖尾与粒子的跟随手感（值越大越跟手，0.05~0.5）',
    'en': 'The glyph itself always follows the pointer exactly (what you see is where you click); this only affects how the trail and particles follow behind (higher = tighter, 0.05–0.5)',
    'de': 'Die Glyphe folgt dem Zeiger immer exakt (Anzeige = Klickpunkt); dies betrifft nur das Nachziehen von Spur und Partikeln (höher = straffer, 0,05–0,5)',
    'es': 'El glifo sigue siempre al puntero con exactitud (lo que ves es donde haces clic); esto solo afecta al arrastre de la estela y las partículas (más alto = más ceñido, 0.05–0.5)',
    'fr': "Le glyphe suit toujours exactement le pointeur (ce que vous voyez est l'endroit où vous cliquez) ; ce réglage ne concerne que la traînée et les particules (plus haut = plus serré, 0,05–0,5)",
    'ja': 'グリフ自体は常にポインタを厳密に追従します（見える位置＝クリック位置）。この設定は軌跡と粒子の追従の手応えだけに影響します（値が大きいほど密着、0.05〜0.5）',
    'ko': '글리프 자체는 항상 포인터를 정확히 따라갑니다(보이는 위치＝클릭 위치). 이 항목은 잔상과 파티클이 따라가는 감각에만 영향을 줍니다(값이 클수록 더 밀착, 0.05~0.5)',
    'pt': 'O glifo acompanha sempre o ponteiro com precisão (o que você vê é onde clica); isto afeta apenas o arrasto do rastro e das partículas (maior = mais ajustado, 0.05–0.5)',
    'ru': 'Сам глиф всегда точно следует за указателем (видимое место = место клика); этот параметр влияет только на «хвост» и частицы (больше = плотнее, 0.05–0.5)',
    'zh-Hant': '游標字形本身始終精確跟隨指標（顯示位置＝點擊位置），此項只影響拖尾與粒子的跟隨手感（值越大越跟手，0.05~0.5）',
}

T['settings.cursorTrailDesc'] = {
    'zh': '光标移动时沿途生成柔性圆点轨迹，半径随生命衰减、渐变消散（可独立开关）',
    'en': 'Soft round dots are left along the path as the cursor moves, shrinking and fading out (independently switchable)',
    'de': 'Beim Bewegen des Cursors bleiben weiche runde Punkte zurück, die schrumpfen und verblassen (einstellbar)',
    'es': 'Al mover el cursor quedan puntos redondos suaves que encogen y se desvanecen (activable por separado)',
    'fr': 'Des points ronds souples restent le long du parcours, rétrécissent et s’estompent (activable séparément)',
    'ja': 'カーソル移動の経路に沿って柔らかな丸点が残り、縮小しながら消えていきます（個別に切り替え可）',
    'ko': '커서를 움직이면 경로 위로 부드러운 원형 점이 남아 작아지며 사라집니다(독립적으로 켜고 끌 수 있음)',
    'pt': 'Ao mover o cursor ficam pontos redondos suaves que encolhem e desvanecem (ativável separadamente)',
    'ru': 'При движении по пути остаются мягкие точки, которые уменьшаются и гаснут (включается отдельно)',
    'zh-Hant': '游標移動時沿途生成柔性圓點軌跡，半徑隨生命衰減、漸變消散（可獨立開關）',
}

T['settings.cursorParticlesDesc'] = {
    'zh': '光标移动时甩出细碎柔光粒子，带速度继承，形成被拖出去的粒子拖动特效（可独立开关）',
    'en': 'Tiny soft-glow particles are flung out with inherited velocity, creating the drag-out particle effect (independently switchable)',
    'de': 'Beim Bewegen des Cursors werden kleine Leuchtpartikel mit geerbter Geschwindigkeit ausgeschleudert (einstellbar)',
    'es': 'Al mover el cursor se lanzan pequeñas partículas luminosas con velocidad heredada, creando el efecto de arrastre (activable por separado)',
    'fr': 'De fines particules lumineuses sont projetées avec une vitesse héritée, créant l’effet de projection (activable séparément)',
    'ja': 'カーソル移動時に速度を引き継いだ微細な発光粒子が飛び出し、引きずるような粒子エフェクトになります（個別に切り替え可）',
    'ko': '커서를 움직이면 속도를 이어받는 작은 발광 입자가 튀어나와 끌리는 듯한 파티클 효과가 납니다(독립적으로 켜고 끌 수 있음)',
    'pt': 'Ao mover o cursor, pequenas partículas luminosas são lançadas com velocidade herdada, criando o efeito de arremesso (ativável separadamente)',
    'ru': 'При движении вылетают мелкие светящиеся частицы с унаследованной скоростью — эффект «протаскивания» (включается отдельно)',
    'zh-Hant': '游標移動時甩出細碎柔光粒子，帶速度繼承，形成被拖出去的粒子拖動特效（可獨立開關）',
}

T['settings.hotspotDesc'] = {
    'zh': '调整光标图上的点击点位置（比例 0~1，相对图片自身宽高）。鼠标实际点击位置＝图上的红点位置，与图片分辨率和光标大小无关',
    'en': 'Choose where the click point sits on the cursor image (a 0–1 ratio of the image’s own width/height). The actual click position = the red dot on the image, independent of image resolution and cursor size',
    'de': 'Legen Sie fest, wo der Klickpunkt auf dem Cursorbild liegt (Verhältnis 0–1 zur Bildbreite/-höhe). Die tatsächliche Klickposition = der rote Punkt, unabhängig von Auflösung und Cursorgröße',
    'es': 'Elige dónde queda el punto de clic en la imagen del cursor (proporción 0–1 del ancho/alto de la propia imagen). La posición real del clic = el punto rojo, sin importar la resolución ni el tamaño del cursor',
    'fr': "Choisissez où se situe le point de clic sur l’image du curseur (ratio 0–1 de la largeur/hauteur de l’image). La position réelle du clic = le point rouge, indépendamment de la résolution et de la taille du curseur",
    'ja': 'カーソル画像上のクリック位置を設定します（画像自身の幅・高さに対する比率 0〜1）。実際のクリック位置＝画像上の赤い点。画像の解像度やカーソルサイズには左右されません',
    'ko': '커서 이미지 위의 클릭 지점을 정합니다(이미지 자체의 너비/높이에 대한 비율 0~1). 실제 클릭 위치＝이미지의 빨간 점이며, 이미지 해상도나 커서 크기와 무관합니다',
    'pt': 'Escolha onde fica o ponto de clique na imagem do cursor (proporção 0–1 da largura/altura da própria imagem). A posição real do clique = o ponto vermelho, independente da resolução e do tamanho do cursor',
    'ru': 'Выберите, где находится точка клика на изображении курсора (доля 0–1 от ширины/высоты самого изображения). Реальное место клика = красная точка, независимо от разрешения и размера курсора',
    'zh-Hant': '調整游標圖上的點擊點位置（比例 0~1，相對圖片自身寬高）。滑鼠實際點擊位置＝圖上的紅點位置，與圖片解析度與游標大小無關',
}

T['settings.hotspotX'] = {
    'zh': '水平比例', 'en': 'Horizontal Ratio',
    'de': 'Horizontales Verhältnis', 'es': 'Proporción horizontal',
    'fr': 'Ratio horizontal', 'ja': '横方向の比率', 'ko': '가로 비율',
    'pt': 'Proporção horizontal', 'ru': 'Горизонтальная доля', 'zh-Hant': '水平比例',
}

T['settings.hotspotY'] = {
    'zh': '垂直比例', 'en': 'Vertical Ratio',
    'de': 'Vertikales Verhältnis', 'es': 'Proporción vertical',
    'fr': 'Ratio vertical', 'ja': '縦方向の比率', 'ko': '세로 비율',
    'pt': 'Proporção vertical', 'ru': 'Вертикальная доля', 'zh-Hant': '垂直比例',
}

T['settings.cursorImageDesc'] = {
    'zh': '上传自定义图片替换默认光标（建议透明背景 PNG，最长边不超过 128 像素）。留空则使用内置光标；上传后点击点默认居中，可在下方预览框拖动微调。',
    'en': 'Upload your own image to replace the default cursor (transparent PNG recommended, longest edge ≤ 128 px). Leave empty to use the built-in cursor; the click point resets to the centre and can be fine-tuned by dragging in the preview below.',
    'de': 'Laden Sie ein eigenes Bild hoch, um den Standardcursor zu ersetzen (transparentes PNG empfohlen, längste Kante ≤ 128 px). Leer lassen für den eingebauten Cursor; der Klickpunkt wird auf die Mitte gesetzt und kann unten feinjustiert werden.',
    'es': 'Sube una imagen propia para sustituir el cursor predeterminado (PNG transparente recomendado, lado mayor ≤ 128 px). Déjalo vacío para usar el cursor integrado; el punto de clic se centra y se puede ajustar arrastrándolo en la vista previa.',
    'fr': "Importez votre propre image pour remplacer le curseur par défaut (PNG transparent recommandé, côté le plus long ≤ 128 px). Laissez vide pour le curseur intégré ; le point de clic est recentré et ajustable dans l’aperçu ci-dessous.",
    'ja': '独自の画像をアップロードして既定カーソルを差し替えます（透明 PNG 推奨、最長辺 128px 以下）。空欄なら内蔵カーソルを使用します。クリック位置は中央にリセットされ、下のプレビューで微調整できます。',
    'ko': '직접 이미지를 업로드해 기본 커서를 교체합니다(투명 PNG 권장, 긴 변 128px 이하). 비워 두면 내장 커서를 사용하며, 클릭 지점은 가운데로 초기화되어 아래 미리보기에서 드래그로 미세 조정할 수 있습니다.',
    'pt': 'Envie uma imagem própria para substituir o cursor padrão (PNG transparente recomendado, lado maior ≤ 128 px). Deixe vazio para usar o cursor incorporado; o ponto de clique é centralizado e pode ser ajustado arrastando na pré-visualização abaixo.',
    'ru': 'Загрузите своё изображение вместо курсора по умолчанию (рекомендуется прозрачный PNG, длинная сторона ≤ 128 px). Оставьте пустым — используется встроенный курсор; точка клика сбрасывается в центр и подстраивается перетаскиванием в превью ниже.',
    'zh-Hant': '上傳自訂圖片取代預設游標（建議透明背景 PNG，最長邊不超過 128 像素）。留空則使用內建游標；上傳後點擊點預設置中，可在下方預覽框拖曳微調。',
}

T['settings.cursorHotspotHint'] = {
    'zh': '鼠标实际点击位置＝图上的红点位置。拖动红点即可调整，拖动过程中立即生效，松开后保存。',
    'en': 'The real click position = the red dot on the image. Drag the dot to adjust — it applies instantly while dragging and is saved on release.',
    'de': 'Die tatsächliche Klickposition = der rote Punkt auf dem Bild. Ziehen Sie den Punkt zum Einstellen — die Änderung wirkt sofort beim Ziehen und wird beim Loslassen gespeichert.',
    'es': 'La posición real del clic = el punto rojo de la imagen. Arrastra el punto para ajustarlo: se aplica al instante mientras arrastras y se guarda al soltar.',
    'fr': "La position réelle du clic = le point rouge sur l’image. Faites glisser le point pour le régler : l’effet est immédiat pendant le glissement et enregistré au relâchement.",
    'ja': '実際のクリック位置＝画像上の赤い点。赤い点をドラッグして調整できます。ドラッグ中は即座に反映され、指を離すと保存されます。',
    'ko': '실제 클릭 위치＝이미지의 빨간 점입니다. 점을 드래그해 조정할 수 있으며, 드래그 중 즉시 반영되고 놓으면 저장됩니다.',
    'pt': 'A posição real do clique = o ponto vermelho na imagem. Arraste o ponto para ajustar: aplica-se de imediato durante o arraste e é guardado ao largar.',
    'ru': 'Реальное место клика = красная точка на изображении. Перетащите точку для настройки — эффект применяется сразу при перетаскивании и сохраняется при отпускании.',
    'zh-Hant': '滑鼠實際點擊位置＝圖上的紅點位置。拖曳紅點即可調整，拖曳過程中立即生效，放開後儲存。',
}

T['settings.cursorImageInvalid'] = {
    'zh': '无法识别该文件，请选择有效的图片（PNG / JPG / WebP）',
    'en': 'That file could not be recognized. Please choose a valid image (PNG / JPG / WebP).',
    'de': 'Die Datei konnte nicht erkannt werden. Bitte wählen Sie ein gültiges Bild (PNG / JPG / WebP).',
    'es': 'No se pudo reconocer el archivo. Elige una imagen válida (PNG / JPG / WebP).',
    'fr': 'Ce fichier n’a pas pu être reconnu. Veuillez choisir une image valide (PNG / JPG / WebP).',
    'ja': 'ファイルを認識できませんでした。有効な画像（PNG / JPG / WebP）を選択してください。',
    'ko': '파일을 인식할 수 없습니다. 유효한 이미지(PNG / JPG / WebP)를 선택하세요.',
    'pt': 'Não foi possível reconhecer o ficheiro. Escolha uma imagem válida (PNG / JPG / WebP).',
    'ru': 'Не удалось распознать файл. Выберите корректное изображение (PNG / JPG / WebP).',
    'zh-Hant': '無法辨識該檔案，請選擇有效的圖片（PNG / JPG / WebP）',
}

T['settings.cursorImageTooLarge'] = {
    'zh': '图片文件过大（上限 4MB），请选择更小的图片',
    'en': 'The image is too large (4MB limit). Please choose a smaller one.',
    'de': 'Das Bild ist zu groß (Limit 4 MB). Bitte wählen Sie ein kleineres Bild.',
    'es': 'La imagen es demasiado grande (límite 4 MB). Elige una más pequeña.',
    'fr': 'L’image est trop volumineuse (limite 4 Mo). Veuillez en choisir une plus petite.',
    'ja': '画像ファイルが大きすぎます（上限 4MB）。より小さい画像を選んでください。',
    'ko': '이미지 파일이 너무 큽니다(최대 4MB). 더 작은 이미지를 선택하세요.',
    'pt': 'A imagem é demasiado grande (limite 4 MB). Escolha uma menor.',
    'ru': 'Файл изображения слишком большой (предел 4 МБ). Выберите меньший.',
    'zh-Hant': '圖片檔案過大（上限 4MB），請選擇較小的圖片',
}

T['settings.cursorImageDecodeFailed'] = {
    'zh': '图片读取失败，请换一张试试',
    'en': 'The image could not be decoded. Please try another one.',
    'de': 'Das Bild konnte nicht dekodiert werden. Bitte versuchen Sie ein anderes.',
    'es': 'No se pudo decodificar la imagen. Prueba con otra.',
    'fr': 'L’image n’a pas pu être décodée. Veuillez en essayer une autre.',
    'ja': '画像をデコードできませんでした。別の画像をお試しください。',
    'ko': '이미지를 디코딩할 수 없습니다. 다른 이미지를 사용해 보세요.',
    'pt': 'Não foi possível descodificar a imagem. Tente outra.',
    'ru': 'Не удалось декодировать изображение. Попробуйте другое.',
    'zh-Hant': '圖片解碼失敗，請換一張試試',
}

LANGS = ['zh', 'en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']

ANCHOR_KEY = 'settings.cursorImageDesc'


def ts_quote(value):
    # translations.ts 内联字典使用单引号字符串
    return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"


def block_range(src, lang):
    # 定位 translations.ts 中某个语言内联块的起止位置
    m = re.search(r"\n  " + re.escape(lang) + r": \{", src)
    if not m:
        raise RuntimeError('language block not found: ' + lang)
    open_idx = src.index('{', m.start())
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return open_idx, i
    raise RuntimeError('unbalanced braces in block: ' + lang)


def update_translations():
    path = os.path.join(ROOT, 'src', 'i18n', 'translations.ts')
    src = io.open(path, encoding='utf-8').read()

    for lang in ('zh', 'en'):
        start, end = block_range(src, lang)
        block = src[start:end]
        for key, per_lang in T.items():
            value = per_lang[lang]
            new_line = "    '%s': %s,\n" % (key, ts_quote(value))
            pattern = re.compile(r"^    '" + re.escape(key) + r"': '.*?',$", re.M)
            if pattern.search(block):
                block = pattern.sub(lambda m: new_line.rstrip('\n'), block, count=1)
            else:
                anchor = "    '%s': " % ANCHOR_KEY
                idx = block.index(anchor)
                line_end = block.index('\n', idx) + 1
                block = block[:line_end] + new_line + block[line_end:]
        src = src[:start] + block + src[end:]

    io.open(path, 'w', encoding='utf-8', newline='').write(src)
    print('ok  src/i18n/translations.ts')


def update_locale(lang):
    path = os.path.join(ROOT, 'src', 'i18n', 'locales', '%s.json' % lang)
    orig = io.open(path, encoding='utf-8').read()
    data = json.loads(orig, object_pairs_hook=collections.OrderedDict)
    for key, per_lang in T.items():
        data[key] = per_lang[lang]
    out = json.dumps(data, ensure_ascii=False, indent=1) + '\n'
    io.open(path, 'w', encoding='utf-8', newline='').write(out)
    print('ok  src/i18n/locales/%s.json' % lang)


if __name__ == '__main__':
    update_translations()
    for lang in LANGS:
        if lang in ('zh', 'en'):
            continue
        update_locale(lang)
    print('done')
