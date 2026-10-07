#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2.3.97：向 8 份 locale JSON 补3 个新键（与 translations.ts 的 zh/en 保持同一语义）。

新键：
  settings.genMovedTitle        —— 生成与扩展分类的新标题（替代原「生成与扩展」，说明内容已搬走）
  settings.genMovedLead         —— 该分类的引导文案
  settings.searchTargetMissing  —— 搜索跳转找不到目标时的可见提示（原先是静默失败）

用法：python scripts/i18n-v2397-settings-index.py
幂等：已存在的键不会被覆盖。
"""

import json
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_DIR = os.path.join(ROOT, 'src', 'i18n', 'locales')

NEW_KEYS = {
    'de': {
        'settings.genMovedTitle': 'Sprach- & Bilddienste',
        'settings.genMovedLead': 'Die API-Konfiguration für diese Dienste (Sprachsynthese, Spracherkennung, Bild- und Videogenerierung) ist zu „Modellverwaltung“ umgezogen – dort lassen sich mehrere Konfigurationen anlegen, eine als aktiv markieren und jederzeit wechseln. Szenenbilder, Websuche, Plugins und Skills bleiben auf dieser Seite.',
        'settings.searchTargetMissing': 'Diese Einstellung wurde nicht gefunden – sie ist möglicherweise durch das aktuelle Design oder einen Schalter ausgeblendet. Prüfe die betreffenden Schalter oben und versuche es erneut.',
    },
    'es': {
        'settings.genMovedTitle': 'Servicios de voz e imagen',
        'settings.genMovedLead': 'La configuración de API de estos servicios (síntesis de voz, voz a texto, generación de imágenes y de vídeo) se ha trasladado a «Gestión de modelos»: allí puedes añadir varias configuraciones, marcar una como activa y cambiarla en cualquier momento. Las imágenes de escena, la búsqueda web, los complementos y las habilidades siguen en esta página.',
        'settings.searchTargetMissing': 'No se encontró ese ajuste: puede estar oculto por el tema actual o por un interruptor. Revisa los interruptores relacionados arriba e inténtalo de nuevo.',
    },
    'fr': {
        'settings.genMovedTitle': 'Services vocaux et image',
        'settings.genMovedLead': 'La configuration API de ces services (synthèse vocale, reconnaissance vocale, génération d’images et de vidéos) a été déplacée vers « Gestion des modèles » : vous pouvez y ajouter plusieurs configurations, en marquer une comme active et changer à tout moment. Les images de scène, la recherche web, les extensions et les compétences restent sur cette page.',
        'settings.searchTargetMissing': 'Ce paramètre est introuvable : il est peut-être masqué par le thème actuel ou par un interrupteur. Vérifiez les interrupteurs concernés ci-dessus et réessayez.',
    },
    'ja': {
        'settings.genMovedTitle': '音声・画像サービス',
        'settings.genMovedLead': 'これらのサービス（音声合成・音声認識・画像生成・動画生成）の API 設定は「モデル管理」に移動しました。那里では複数の設定を追加し、使用中としてマークしていつでも切り替えられます。シーン画像・ウェブ検索・プラグイン・スキルはこのページに残っています。',
        'settings.searchTargetMissing': 'その設定項目が見つかりませんでした。現在のテーマやスイッチによって非表示になっている可能性があります。上部の関連スイッチを確認してから、もう一度お試しください。',
    },
    'ko': {
        'settings.genMovedTitle': '음성·이미지 서비스',
        'settings.genMovedLead': '이 서비스(음성 합성, 음성 인식, 이미지·영상 생성)의 API 설정은 「모델 관리」 페이지로 이동했습니다. 거기에서 여러 설정을 추가하고 사용 중인 것으로 표시한 뒤 언제든 전환할 수 있습니다. 장면 이미지, 웹 검색, 플러그인, 스킬은 이 페이지에 그대로 있습니다.',
        'settings.searchTargetMissing': '해당 설정을 찾을 수 없습니다. 현재 테마나 스위치에 의해 숨겨져 있을 수 있습니다. 위의 관련 스위치를 확인한 후 다시 시도해 주세요.',
    },
    'pt': {
        'settings.genMovedTitle': 'Serviços de voz e imagem',
        'settings.genMovedLead': 'A configuração de API destes serviços (síntese de voz, voz para texto, geração de imagens e de vídeo) foi movida para “Gerenciamento de modelos”: lá você pode adicionar várias configurações, marcar uma como ativa e trocar a qualquer momento. Imagens de cena, busca na web, plugins e habilidades continuam nesta página.',
        'settings.searchTargetMissing': 'Essa configuração não foi encontrada — ela pode estar oculta pelo tema atual ou por um interruptor. Verifique os interruptores relacionados acima e tente novamente.',
    },
    'ru': {
        'settings.genMovedTitle': 'Голосовые сервисы и генерация изображений',
        'settings.genMovedLead': 'API-конфигурация этих сервисов (синтез речи, распознавание речи, генерация изображений и видео) перенесена в раздел «Управление моделями»: там можно добавить несколько конфигураций, отметить одну как активную и переключаться в любой момент. Изображения сцен, веб-поиск, плагины и навыки остаются на этой странице.',
        'settings.searchTargetMissing': 'Эта настройка не найдена — возможно, она скрыта текущей темой или переключателем. Проверьте соответствующие переключатели выше и попробуйте снова.',
    },
    'zh-Hant': {
        'settings.genMovedTitle': '語音與生圖服務',
        'settings.genMovedLead': '這一類服務（語音合成、語音輸入、生圖、生影片）的 API 設定已移入「模型管理」頁 —— 在那裡可以新增多條設定、標記目前使用項並隨時切換。本頁保留了場景生圖、網路搜尋、外掛與技能。',
        'settings.searchTargetMissing': '找不到該設定項，可能它已隨目前主題或開關狀態而隱藏。請檢查上方相關開關後再試。',
    },
}


def main() -> int:
    for lang, keys in NEW_KEYS.items():
        path = os.path.join(LOCALES_DIR, f'{lang}.json')
        if not os.path.exists(path):
            print(f'  SKIP  {lang}: 文件不存在')
            continue
        with io.open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        added = [k for k in keys if k not in data]
        # 关键：**保持原有 key 顺序**，只把新键追加到末尾。
        # 早期版本在这里做了 sorted()，但这些文件本来就不是全局有序的（各语言包由不同人
        # 陆续追加键），重排会产生 300+ 行无关 diff，把其他人的改动淹没 —— 必须避免。
        data.update(keys)
        # indent=2：仓库既有语言包用的是 2 空格缩进，而 json.dump 的默认值是 1 ——
        # 用默认值会把 1700 行全部改成 1 空格，产生满屏无关 diff，必须显式指定。
        with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write('\n')
        print(f'  {"OK  " if added else "SKIP"}  {lang}: 新增 {len(added)} / 共 {len(keys)} 个键')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())