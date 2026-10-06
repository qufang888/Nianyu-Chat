#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2.3.94 需求 8/9 收尾：人物音色绑定统一到角色卡编辑器 —— i18n 批量同步。

背景：设置页里旧的「按数字人角色分别配置 TTS 音色」表单已删除（与角色卡编辑器
两套可编辑表单并存会让用户困惑，且可能互相覆盖 settings.voice.ttsVoices[roleId]），
改为只留一个跳转到角色卡编辑器的入口。故：
  - 新增 settings.ttsPerRoleGoRoleCard / ...Desc 两个键（跳转按钮 + 说明）；
  - 改写 settings.ttsVoicePerRoleDesc —— 原文描述的是被删掉的那套表单
    （"服务端不支持列接口时回退内置清单 alloy/echo/..."），已与实际行为不符。

做法与 scripts/i18n-media-configs.py 同款：
  - translations.ts 的 zh / en 两段：就地插入到锚点键之后，保持键序稳定；
  - src/i18n/locales/ 下 8 个 JSON：同样插到锚点之后（幂等，重复跑不会重复插入）；
  - CRLF 行尾 + 2 空格缩进 + ensure_ascii=False，与既有文件保持一致。

术语沿用各语言既有译法：角色卡 = 人物卡 / Charakterkarte / ficha de personaje 等。
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES = os.path.join(ROOT, 'src', 'i18n', 'locales')
TRANSLATIONS = os.path.join(ROOT, 'src', 'i18n', 'translations.ts')

# 锚点键：新键插到它之后（紧随 per-role 小节，语义相邻）
ANCHOR = 'settings.ttsVoicePerRoleDesc'

# 需要整体改写的既有键（文案已随 UI 迁移而变化）
REWRITE = {
    'settings.ttsVoicePerRoleDesc': {
        'zh': '人物音色在角色卡里配置：编辑人物 → 「人物音色与朗读」，可绑定具体 TTS 配置、拉取音色列表或手填音色 ID，并单独设置语速与音调。',
        'en': 'Character voices are configured on the character card: edit a character → “Character voice & read-aloud” to bind a specific TTS configuration, fetch its voice list or type a voice ID, and set speed and pitch for that character.',
        'de': 'Charakterstimmen werden auf der Charakterkarte konfiguriert: Figur bearbeiten → „Charakterstimme & Vorlesen“, um eine TTS-Konfiguration zu binden, die Stimmliste abzurufen oder eine Stimm-ID einzugeben sowie Sprechtempo und Tonhöhe je Figur zu setzen.',
        'es': 'Las voces de los personajes se configuran en la ficha del personaje: edita un personaje → «Voz y lectura en voz alta» para vincular una configuración de TTS, obtener su lista de voces o escribir un ID de voz, y ajustar velocidad y tono por personaje.',
        'fr': 'Les voix des personnages se règlent sur la fiche du personnage : éditez un personnage → « Voix et lecture à voix haute » pour lier une configuration TTS, récupérer sa liste de voix ou saisir un identifiant de voix, et régler vitesse et hauteur par personnage.',
        'ja': '人物の音声はキャラクターカードで設定します。人物を編集 →「人物の音声と読み上げ」で、特定の TTS 設定の紐づけ、音声一覧の取得、音声 ID の直接入力、その人物だけの話速とピッチの設定ができます。',
        'ko': '인물의 음성은 캐릭터 카드에서 설정합니다. 인물 편집 → 「인물 음성 및 읽어주기」에서 특정 TTS 설정을 연결하고, 음성 목록을 가져오거나 음성 ID를 직접 입력하며, 인물별로 말하기 속도와 높이를 조절할 수 있습니다.',
        'pt': 'As vozes dos personagens são configuradas no cartão do personagem: edite um personagem → «Voz e leitura em voz alta» para vincular uma configuração de TTS, obter a lista de vozes ou digitar um ID de voz e ajustar velocidade e tom por personagem.',
        'ru': 'Голоса персонажей настраиваются на карточке персонажа: откройте «Голос и озвучивание», чтобы привязать конфигурацию TTS, получить список голосов или ввести ID голоса, а также задать скорость и высоту тона для персонажа.',
        'zh-Hant': '人物音色在角色卡裡設定：編輯人物 →「人物音色與朗讀」，可綁定特定 TTS 設定、拉取音色清單或手填音色 ID，並單獨設定語速與音調。',
    },
}

# ===== 新增 key -> {lang: text}（10 种语言）=====
NEW = {
    'settings.ttsPerRoleGoRoleCard': {
        'zh': '前往通讯录编辑人物音色',
        'en': 'Go to Contacts to edit character voices',
        'de': 'Zu den Kontakten, um Charakterstimmen zu bearbeiten',
        'es': 'Ir a Contactos para editar las voces de los personajes',
        'fr': 'Aller dans Contacts pour modifier les voix des personnages',
        'ja': '連絡先へ移動して人物の音声を編集',
        'ko': '연락처로 이동해 인물 음성 편집',
        'pt': 'Ir para Contatos e editar as vozes dos personagens',
        'ru': 'Перейти в «Контакты» для настройки голосов персонажей',
        'zh-Hant': '前往通訊錄編輯人物音色',
    },
    'settings.ttsPerRoleGoRoleCardDesc': {
        'zh': '音色绑定已移到人物角色卡里（一个人物一张卡，音色、语速、音调都在卡上配）。这里只保留 TTS / 语音输入等服务的多条 API 配置。',
        'en': 'Voice bindings now live on each character card (one card per character, with voice, speed and pitch). This page keeps only the multi-configuration API settings for TTS, speech-to-text and the other services.',
        'de': 'Stimmenbindungen liegen jetzt auf der jeweiligen Charakterkarte (eine Karte pro Figur, mit Stimme, Sprechtempo und Tonhöhe). Diese Seite enthält nur noch die API-Konfigurationen für TTS, Spracheingabe und weitere Dienste.',
        'es': 'Las vinculaciones de voz viven ahora en la ficha de cada personaje (una ficha por personaje, con voz, velocidad y tono). Esta página conserva solo las configuraciones de API de TTS, voz a texto y los demás servicios.',
        'fr': 'Les liens de voix se trouvent désormais sur la fiche de chaque personnage (une fiche par personnage, avec voix, vitesse et tonalité). Cette page ne conserve que les configurations d’API pour le TTS, la reconnaissance vocale et les autres services.',
        'ja': '音声の紐づけは各キャラクターカードにあります（1 人物 1 カードで、音声・話速・ピッチを設定）。このページには TTS・音声認識などの複数 API 設定のみが残っています。',
        'ko': '음성 연결은 이제 각 인물 캐릭터 카드에 있습니다(인물당 카드 1장에 음성·말하기 속도·높이를 설정). 이 페이지에는 TTS·음성 인식 등 여러 API 설정만 남아 있습니다.',
        'pt': 'As vinculações de voz agora ficam no cartão de cada personagem (um cartão por personagem, com voz, velocidade e tom). Esta página mantém apenas as configurações de API de TTS, voz-para-texto e outros serviços.',
        'ru': 'Привязки голосов теперь хранятся на карточке персонажа (по одной карточке на персонажа — голос, скорость и высота тона). На этой странице остались только настройки API для TTS, распознавания речи и других сервисов.',
        'zh-Hant': '音色綁定已移到人物角色卡裡（一個人物一張卡，音色、語速、音調都在卡上配）。這裡只保留 TTS / 語音輸入等服務的多條 API 設定。',
    },
}


def _dump(obj, path):
    """按既有格式落盘：CRLF 行尾 + 2 空格缩进 + 不转义非 ASCII。"""
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text.replace('\n', '\r\n'))
        f.write('\r\n')


def patch_translations():
    with io.open(TRANSLATIONS, 'r', encoding='utf-8', newline='') as f:
        raw = f.read()
    crlf = '\r\n' in raw
    src = raw.replace('\r\n', '\n')
    i = src.index('  zh: {')
    j = src.index('\n  en: {')
    end = src.rindex('\n};')
    head, zh_seg, en_seg, tail = src[:i], src[i:j], src[j:end], src[end:]

    inserted = 0
    rewritten = 0
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

        # 改写锚点自身的值（键名不变，只换文案）
        for key, texts in REWRITE.items():
            prefix = "    '%s':" % key
            for idx, ln in enumerate(lines):
                if ln.startswith(prefix):
                    lines[idx] = "%s '%s'," % (prefix, texts[lang].replace("'", "\\'"))
                    rewritten += 1
                    break
            else:
                raise SystemExit('rewrite key %s not found in %s segment' % (key, seg_name))

        # 追加新键（已存在则跳过 → 幂等）
        block = []
        for key in NEW:
            prefix = "    '%s':" % key
            if any(ln.startswith(prefix) for ln in lines):
                continue
            block.append("%s '%s'," % (prefix, NEW[key][lang].replace("'", "\\'")))
        lines[anchor_idx + 1:anchor_idx + 1] = block
        inserted += len(block)

        if seg_name == 'zh':
            zh_seg = '\n'.join(lines)
        else:
            en_seg = '\n'.join(lines)

    out = head + zh_seg + en_seg + tail
    if crlf:
        out = out.replace('\n', '\r\n')
    with io.open(TRANSLATIONS, 'w', encoding='utf-8', newline='') as f:
        f.write(out)
    return inserted, rewritten


def patch_locale(path, lang):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        raw = f.read()
    crlf = '\r\n' in raw
    data = json.loads(raw.replace('\r\n', '\n'))
    if ANCHOR not in data:
        raise SystemExit('anchor %s missing in %s' % (ANCHOR, path))

    for key, texts in REWRITE.items():
        if key not in data:
            raise SystemExit('rewrite key %s missing in %s' % (key, path))
        data[key] = texts[lang]

    before = len(data)
    fresh = [k for k in NEW if k not in data]
    for k in fresh:
        data[k] = NEW[k][lang]

    # 维持既有键序：新键插到锚点之后（fresh 为空 → 纯改写，键序不动）
    if fresh:
        order = [k for k in data.keys() if k not in NEW]
        idx = order.index(ANCHOR) + 1
        for offset, k in enumerate(fresh):
            order.insert(idx + offset, k)
        data = {k: data[k] for k in order}

    _dump(data, path)
    return before, len(data), crlf


def main():
    inserted, rewritten = patch_translations()
    print('translations.ts: +%d new lines, %d rewritten (zh + en)' % (inserted, rewritten))
    for lang in ['de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant']:
        path = os.path.join(LOCALES, '%s.json' % lang)
        if not os.path.exists(path):
            print('SKIP (missing) %s' % path)
            continue
        before, after, crlf = patch_locale(path, lang)
        print('%-8s %4d -> %4d keys  (+%d)%s' % (
            lang, before, after, after - before, '' if crlf else '  [WARN: was LF]'))
    return 0


if __name__ == '__main__':
    sys.exit(main())