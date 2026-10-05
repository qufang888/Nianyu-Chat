#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2.3.92 动画控制三档：i18n 批量同步（translations.ts 的 zh/en + locales/ 下 8 个 JSON）。"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANS = os.path.join(ROOT, 'src', 'i18n', 'translations.ts')
LOCALES = os.path.join(ROOT, 'src', 'i18n', 'locales')

# ---------------------------------------------------------------- 新键（真实翻译）
NEW = {
    'zh': {
        'animCtl.modeAllOn': '全部开启',
        'animCtl.modeAllOff': '全部关闭',
        'animCtl.modeCustom': '自定义',
        'animCtl.modeAllOnHint': '所有界面动画与过渡全部播放，不受任何分组限制。',
        'animCtl.modeAllOffHint': '所有界面动画与过渡全部关闭，可提升低配电脑的流畅度。',
        'animCtl.modeCustomHint': '仅由下方勾选的分组播放动画；未勾选的分组一律静止不动。',
        'animCtl.groupTutorial': '新手引导高亮',
    },
    'en': {
        'animCtl.modeAllOn': 'All on',
        'animCtl.modeAllOff': 'All off',
        'animCtl.modeCustom': 'Custom',
        'animCtl.modeAllOnHint': 'Every UI animation and transition plays; no per-group limits apply.',
        'animCtl.modeAllOffHint': 'Every UI animation and transition is turned off, which improves smoothness on low-end devices.',
        'animCtl.modeCustomHint': 'Only the groups you check below play their animations; unchecked groups stay completely still.',
        'animCtl.groupTutorial': 'Onboarding highlight',
    },
    'de': {
        'animCtl.modeAllOn': 'Alle an',
        'animCtl.modeAllOff': 'Alle aus',
        'animCtl.modeCustom': 'Benutzerdefiniert',
        'animCtl.modeAllOnHint': 'Sämtliche Oberflächenanimationen und Übergänge werden abgespielt; es gelten keine Gruppengrenzen.',
        'animCtl.modeAllOffHint': 'Sämtliche Oberflächenanimationen und Übergänge sind deaktiviert, was auf schwächeren Geräten für mehr Flüssigkeit sorgt.',
        'animCtl.modeCustomHint': 'Nur die unten angehakten Gruppen spielen ihre Animationen ab; nicht angehakte Gruppen bleiben völlig unbewegt.',
        'animCtl.groupTutorial': 'Einrichtungs-Hervorhebung',
    },
    'es': {
        'animCtl.modeAllOn': 'Todo activado',
        'animCtl.modeAllOff': 'Todo desactivado',
        'animCtl.modeCustom': 'Personalizado',
        'animCtl.modeAllOnHint': 'Se reproducen todas las animaciones y transiciones de la interfaz; no se aplica ningún límite por grupo.',
        'animCtl.modeAllOffHint': 'Todas las animaciones y transiciones de la interfaz están desactivadas, lo que mejora la fluidez en equipos modestos.',
        'animCtl.modeCustomHint': 'Solo los grupos que active reproducen sus animaciones; los grupos no activados quedan completamente quietos.',
        'animCtl.groupTutorial': 'Resaltado del tutorial',
    },
    'fr': {
        'animCtl.modeAllOn': 'Tout activé',
        'animCtl.modeAllOff': 'Tout désactivé',
        'animCtl.modeCustom': 'Personnalisé',
        'animCtl.modeAllOnHint': 'Toutes les animations et transitions de l’interface sont jouées ; aucune limite par groupe ne s’applique.',
        'animCtl.modeAllOffHint': 'Toutes les animations et transitions de l’interface sont désactivées, ce qui fluidifie les machines modestes.',
        'animCtl.modeCustomHint': 'Seuls les groupes cochés ci-dessous jouent leurs animations ; les groupes non cochés restent totalement immobiles.',
        'animCtl.groupTutorial': 'Mise en évidence du tutoriel',
    },
    'ja': {
        'animCtl.modeAllOn': 'すべてオン',
        'animCtl.modeAllOff': 'すべてオフ',
        'animCtl.modeCustom': 'カスタム',
        'animCtl.modeAllOnHint': 'すべての UI アニメーションとトランジションを再生します。グループごとの制限は適用されません。',
        'animCtl.modeAllOffHint': 'すべての UI アニメーションとトランジションを停止します。低スペック端末では動作が滑らかになります。',
        'animCtl.modeCustomHint': '下 でチェックしたグループだけがアニメーションを再生し、未チェックのグループは完全に静止します。'.replace('下 で', '下で'),
        'animCtl.groupTutorial': 'オンボーディングのハイライト',
    },
    'ko': {
        'animCtl.modeAllOn': '모두 켜기',
        'animCtl.modeAllOff': '모두 끄기',
        'animCtl.modeCustom': '사용자 지정',
        'animCtl.modeAllOnHint': '모든 UI 애니메이션과 전환을 재생하며, 그룹별 제한은 적용되지 않습니다.',
        'animCtl.modeAllOffHint': '모든 UI 애니메이션과 전환을 끄므로 저사양 PC에서 동작이 더 매끄러워집니다.',
        'animCtl.modeCustomHint': '아래에서 체크한 그룹만 애니메이션을 재생하고, 체크하지 않은 그룹은 완전히 멈춰 있습니다.',
        'animCtl.groupTutorial': '온보딩 하이라이트',
    },
    'pt': {
        'animCtl.modeAllOn': 'Tudo ligado',
        'animCtl.modeAllOff': 'Tudo desligado',
        'animCtl.modeCustom': 'Personalizado',
        'animCtl.modeAllOnHint': 'Todas as animações e transições da interface são reproduzidas; não se aplicam limites por grupo.',
        'animCtl.modeAllOffHint': 'Todas as animações e transições da interface estão desligadas, o que torna computers modestos mais fluidos.',
        'animCtl.modeCustomHint': 'Apenas os grupos marcados abaixo reproduzem as suas animações; os grupos não marcados ficam completamente imóveis.',
        'animCtl.groupTutorial': 'Realce do tutorial',
    },
    'ru': {
        'animCtl.modeAllOn': 'Все включены',
        'animCtl.modeAllOff': 'Все выключены',
        'animCtl.modeCustom': 'Настраиваемый',
        'animCtl.modeAllOnHint': 'Воспроизводятся все анимации и переходы интерфейса; ограничения по группам не применяются.',
        'animCtl.modeAllOffHint': 'Все анимации и переходы интерфейса выключены — на слабых компьютерах работа становится плавнее.',
        'animCtl.modeCustomHint': 'Анимации воспроизводят только те группы, которые отмечены ниже; неотмеченные группы полностью неподвижны.',
        'animCtl.groupTutorial': 'Подсветка обучения',
    },
    'zh-Hant': {
        'animCtl.modeAllOn': '全部開啟',
        'animCtl.modeAllOff': '全部關閉',
        'animCtl.modeCustom': '自訂',
        'animCtl.modeAllOnHint': '所有介面動畫與過場全部播放，不受任何分組限制。',
        'animCtl.modeAllOffHint': '所有介面動畫與過場全部關閉，可提升低配電腦的流暢度。',
        'animCtl.modeCustomHint': '僅由下方勾選的分組播放動畫；未勾選的分組一律靜止不動。',
        'animCtl.groupTutorial': '新手引導高亮',
    },
}

# 需要删除的旧键（二元「总控/单控」语义已随三档制下线）
REMOVE = [
    'animCtl.masterHint',
    'animCtl.singleHint',
    'animCtl.masterTakenOver',
    'animCtl.backToMaster',
]

# streamNote 措辞更新（三档下豁免依然成立，但不再提"总控/单控"）
STREAM_NOTE = {
    'zh': '说明：AI 回复的流式打字机动画在任意档位下都始终开启（否则文字会整段闪现，看不出正在输出）。',
    'en': 'Note: the typewriter animation of AI replies stays on in every mode (otherwise text would flash in whole blocks and you could not tell that it is being generated).',
    'de': 'Hinweis: Die Schreibmaschinen-Animation der KI-Antworten bleibt in jedem Modus aktiv (sonst erscheint Text blockweise und man erkennt nicht, dass geschrieben wird).',
    'es': 'Nota: la animación de máquina de escribir de las respuestas de la IA permanece activa en todos los modos (si no, el texto aparecería por bloques y no se vería que se está generando).',
    'fr': 'Remarque : l’animation de machine à écrire des réponses de l’IA reste active dans tous les modes (sinon le texte apparaîtrait par blocs et on ne verrait plus que la génération est en cours).',
    'ja': '注意：AI 回答のタイプライターアニメーションはどのモードでも常に有効です（無効にすると文字がまとめて表示され、生成中かどうかが分からなくなります）。',
    'ko': '참고: AI 응답의 타자기 애니메이션은 어떤 모드에서도 항상 켜져 있습니다(그렇지 않으면 문장이 한꺼번에 나타나 생성 중인지 알 수 없습니다).',
    'pt': 'Nota: a animação de máquina de escrever das respostas da IA permanece ativa em todos os modos (caso contrário o texto apareceria em blocos e não se percebia que estava a ser gerado).',
    'ru': 'Примечание: анимация печатной машинки в ответах ИИ всегда включена (иначе текст появлялся бы блоками и было бы незаметно, что идёт генерация).',
    'zh-Hant': '說明：AI 回覆的串流打字機動畫在任何檔位下都恆開（否則文字會整段閃現，看不出正在輸出）。',
}


def patch_dict(d: dict, lang: str) -> dict:
    """删旧键 → 改 streamNote → 追加新键（保持插入顺序稳定）"""
    for k in REMOVE:
        d.pop(k, None)
    if 'animCtl.streamNote' in d:
        d['animCtl.streamNote'] = STREAM_NOTE[lang]
    for k, v in NEW[lang].items():
        d[k] = v
    return d


def write_json(path: str, d: dict) -> None:
    """仓库内 i18n 文件统一为 CRLF 行尾（与既有文件保持一致，避免整文件diff）。"""
    with io.open(path, 'w', encoding='utf-8', newline='\r\n') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write('\n')


def patch_translations() -> bool:
    """translations.ts：zh 段在 en 段之前。按字节保留原行尾（该文件是 CRLF/LF 混合的，
    粗暴地整体转换会把无关的几十行也带进 diff）。"""
    with io.open(TRANS, encoding='utf-8', newline='') as f:
        src = f.read()
    en_anchor = src.index('\n  en: {')
    head, tail = src[:en_anchor], src[en_anchor:]

    ok = True
    for lang, seg in (('zh', head), ('en', tail)):
        lines = seg.split('\n')
        out = []
        i = 0
        found = 0
        while i < len(lines):
            line = lines[i]
            m = re.match(r"^(\s*)'(animCtl\.[A-Za-z]+)':\s", line)
            if m:
                key = m.group(2)
                indent = m.group(1)
                # 复用被替换/删除行的原始行尾（strip 掉已计入 \r 的残留）
                eol = '\r' if line.endswith('\r') else ''
                if key in REMOVE:
                    i += 1
                    continue
                if key == 'animCtl.streamNote':
                    esc = STREAM_NOTE[lang].replace('\\', '\\\\').replace("'", "\\'")
                    out.append("%s'%s': '%s',%s" % (indent, key, esc, eol))
                    found += 1
                    i += 1
                    # streamNote 之后追加新键（缩进对齐原键）
                    for nk, nv in NEW[lang].items():
                        nesc = nv.replace('\\', '\\\\').replace("'", "\\'")
                        out.append("%s'%s': '%s',%s" % (indent, nk, nesc, eol))
                    continue
            out.append(line)
            i += 1
        if found != 1:
            print('  !! %s 段 streamNote 定位异常（找到 %d 处）' % (lang, found), file=sys.stderr)
            ok = False
        seg = '\n'.join(out)
        if lang == 'zh':
            head = seg
        else:
            tail = seg

    with io.open(TRANS, 'w', encoding='utf-8', newline='') as f:
        f.write(head + tail)
    return ok


def main() -> None:
    # 1) locales/*.json
    for fn in sorted(os.listdir(LOCALES)):
        if not fn.endswith('.json'):
            continue
        lang = fn[:-5]
        if lang not in NEW:
            print('  ?? 跳过未预期的 locale 文件：%s' % fn, file=sys.stderr)
            continue
        path = os.path.join(LOCALES, fn)
        with io.open(path, encoding='utf-8') as f:
            d = json.load(f)
        before = len(d)
        patch_dict(d, lang)
        write_json(path, d)
        print('  %-10s keys %d -> %d' % (lang, before, len(d)))

    # 2) translations.ts
    print('  translations.ts %s' % ('OK' if patch_translations() else 'FAILED'))


if __name__ == '__main__':
    main()
