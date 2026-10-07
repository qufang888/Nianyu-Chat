"""v2.3.97：液态玻璃（liquid）主题的 10 语言文案同步。

一次性把以下键写入 translations.ts（zh / en）与 src/i18n/locales/*.json（其余 8 语言）：
  - theme.liquid            主题名（设置页主题卡 + 新手引导共用 THEMES 数组）
  - settings.liquidFlow     「液态流动」开关标题
  - settings.liquidFlowDesc 开关说明（Hint 气泡）

为什么用脚本而不是手改 10 份 JSON：
  键名与插入位置完全一致，手改极易漏语言或打错字；脚本对每个语言都断言
  「写入了预期的 3 个键」，漏一个立即失败。

为什么**按行插入**而不是 json.dump 重写整个 JSON：
  locale JSON 的键并非全局字典序（部分键被人为挪过位置），整体重写会产生
  几千行无意义diff，还会和并行工程师的改动冲突。故只在锚点行后插一行，
  保持其余字节完全不变（已用「插入前后行数只 +N」断言）。
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 10 语言文案：theme.liquid / settings.liquidFlow / settings.liquidFlowDesc
T = {
    'zh': {
        'theme.liquid': '液态玻璃',
        'settings.liquidFlow': '液态流动',
        'settings.liquidFlowDesc': '让背景的渐变缓慢流动，营造流体折射的观感。觉得太动态可以关掉；关闭后背景静止，但配色不变。',
    },
    'en': {
        'theme.liquid': 'Liquid Glass',
        'settings.liquidFlow': 'Liquid flow',
        'settings.liquidFlowDesc': 'Slowly drifts the background gradient to mimic fluid refraction. Turn it off if it feels too dynamic — the background stays still and the colors are unchanged.',
    },
    'de': {
        'theme.liquid': 'Flüssigglas',
        'settings.liquidFlow': 'Flüssige Bewegung',
        'settings.liquidFlowDesc': 'Lässt den Hintergrundverlauf langsam driften und imitiert die Brechung einer Flüssigkeit. Ausschalten, wenn es zu dynamisch wirkt – der Hintergrund bleibt dann statisch, die Farben ändern sich nicht.',
    },
    'es': {
        'theme.liquid': 'Cristal líquido',
        'settings.liquidFlow': 'Flujo líquido',
        'settings.liquidFlowDesc': 'Desplaza lentamente el degradado de fondo para imitar la refracción de un fluido. Desactívalo si te parece demasiado dinámico: el fondo queda quieto y los colores no cambian.',
    },
    'fr': {
        'theme.liquid': 'Verre liquide',
        'settings.liquidFlow': 'Flux liquide',
        'settings.liquidFlowDesc': "Fait dériver lentement le dégradé d'arrière-plan pour imiter la réfraction d'un fluide. Désactivez-le si le résultat vous semble trop animé : l'arrière-plan reste fixe et les couleurs inchangées.",
    },
    'ja': {
        'theme.liquid': 'リキッドグラス',
        'settings.liquidFlow': '流動アニメーション',
        'settings.liquidFlowDesc': '背景のグラデーションをゆっくり流すように動かして、流体の屈折を再現します。動きが大きすぎると感じる場合はオフにしてください。背景は静止したまま、配色は変わりません。',
    },
    'ko': {
        'theme.liquid': '리퀴드 글래스',
        'settings.liquidFlow': '액체 흐름',
        'settings.liquidFlowDesc': '배경 그라데이션을 천천히 흐르게 하여 유체의 굴절을 흉내냅니다. 너무 역동적이라고 느끼면 끄세요. 배경은 멈춰 있고 색상은 그대로입니다.',
    },
    'pt': {
        'theme.liquid': 'Vidro líquido',
        'settings.liquidFlow': 'Fluxo líquido',
        'settings.liquidFlowDesc': 'Faz o degradê de fundo derivar lentamente para imitar a refração de um fluido. Desligue se parecer demasiado dinâmico — o fundo fica parado e as cores não mudam.',
    },
    'ru': {
        'theme.liquid': 'Жидкое стекло',
        'settings.liquidFlow': 'Жидкое течение',
        'settings.liquidFlowDesc': 'Медленно перемещает градиент фона, имитируя преломление жидкости. Выключите, если движение кажется слишком навязчивым — фон замирает, цвета не меняются.',
    },
    'zh-Hant': {
        'theme.liquid': '液態玻璃',
        'settings.liquidFlow': '液態流動',
        'settings.liquidFlowDesc': '讓背景的漸層緩慢流動，營造流體折射的觀感。若覺得太動態可關閉；關閉後背景靜止，但配色不變。',
    },
}

KEYS = ['theme.liquid', 'settings.liquidFlow', 'settings.liquidFlowDesc']

# locale JSON 里用来定位插入点的锚点键（每个语言文件里都必须存在）
LOCALE_ANCHORS = ['settings.glassColorReset', 'theme.sand']


def js_str(s: str) -> str:
    """把字符串渲染成一行 JSON（保留非 ASCII，转义双引号与反斜杠）。"""
    return json.dumps(s, ensure_ascii=False)


def insert_after(src_lines: list, anchor: str, new_lines: list) -> tuple:
    """在第一次出现 anchor 的那一行之后插入 new_lines，返回新行表与是否命中。

    anchor 传入的是「已渲染好的单行前缀」（如`  "theme.sand": `），
    以便同一段代码既能处理 .ts（单引号）也能处理 .json（双引号）。
    """
    out = []
    hit = False
    for line in src_lines:
        out.append(line)
        if not hit and line.startswith(anchor):
            out.extend(new_lines)
            hit = True
    return out, hit


def patch_translations() -> None:
    """在 translations.ts 的 zh / en 两段里各插入 3 个键。

    锚点：`'theme.sand'`（主题名块末尾）与 `'settings.glassColorReset'`（毛玻璃面板末尾）。
    translations.ts 里 zh 段在前、en 段在后，同一个锚点文本会出现两次；
    故按出现次序分别灌入 zh 文案、en 文案。
    """
    p = os.path.join(ROOT, 'src', 'i18n', 'translations.ts')
    with io.open(p, encoding='utf-8') as f:
        text = f.read()
    nl = '\r\n' if '\r\n' in text else '\n'
    src_lines = text.splitlines()

    def once(lines: list, anchor: str, key: str) -> list:
        """把某个 key 的 zh / en 两行分别插到该锚点的第 1 / 第 2 次出现之后。

        幂等：若该key 的 zh 行已存在（本脚本可重复运行），则整段跳过。
        """
        already = any(line.startswith("    '%s': " % key) for line in lines)
        if already:
            return lines
        state = {'seen': 0}
        out = []
        for line in lines:
            out.append(line)
            if line.startswith(anchor):
                lang = 'zh' if state['seen'] == 0 else 'en'
                state['seen'] += 1
                out.append("    '%s': %s," % (key, js_str(T[lang][key])))
        assert state['seen'] == 2, "translations.ts 里锚点 %s 出现 %d 次（应为 2：zh + en）" % (
            anchor,
            state['seen'],
        )
        return out

    # 先插 theme.liquid（锚点 theme.sand），再插开关文案（锚点 glassColorReset）
    src_lines = once(src_lines, "    'theme.sand':", 'theme.liquid')
    for key in ('settings.liquidFlow', 'settings.liquidFlowDesc'):
        src_lines = once(src_lines, "    'settings.glassColorReset':", key)

    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(nl.join(src_lines) + nl)

    with io.open(p, encoding='utf-8') as f:
        content = f.read()
    for k in KEYS:
        n = content.count("'%s':" % k)
        assert n == 2, 'translations.ts 里 %s 出现 %d 次（应为 2：zh + en）' % (k, n)
    print('  OK  translations.ts  zh + en  各 %d 键' % len(KEYS))


def patch_locale(lang: str) -> None:
    """在单个语言 JSON 的锚点键之后插入 3 行（保持其余字节不变）。"""
    p = os.path.join(ROOT, 'src', 'i18n', 'locales', '%s.json' % lang)
    with io.open(p, encoding='utf-8') as f:
        text = f.read()
    # 幂等：3 个键都已存在则整个文件跳过（本脚本可重复运行）
    if all(('"%s":' % k) in text for k in KEYS):
        print('  SKIP %-12s 已存在，跳过' % (lang + '.json'))
        return
    nl = '\r\n' if '\r\n' in text else '\n'
    src_lines = text.splitlines()
    before = len(src_lines)

    for anchor in LOCALE_ANCHORS:
        keys = ['theme.liquid'] if anchor == 'theme.sand' else ['settings.liquidFlow', 'settings.liquidFlowDesc']
        new_lines = [' %s: %s,' % (js_str(k), js_str(T[lang][k])) for k in keys]
        src_lines, hit = insert_after(src_lines, ' %s: ' % js_str(anchor), new_lines)
        assert hit, '%s.json 里找不到锚点 %s' % (lang, anchor)

    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(nl.join(src_lines) + nl)

    # 回读校验：JSON 仍合法 + 3 个键值正确 + 只增了预期的行数
    with io.open(p, encoding='utf-8') as f:
        back = json.load(f)
    for k in KEYS:
        assert back[k] == T[lang][k], '%s.json 的 %s 写入后读回不一致' % (lang, k)
    assert len(src_lines) == before + 3, '%s.json 行数增量异常：%d -> %d' % (lang, before, len(src_lines))
    print('  OK  %-12s %d 键（行数 %d -> %d）' % (lang + '.json', len(KEYS), before, len(src_lines)))


def main() -> int:
    print('== v2.3.97 液态玻璃 i18n 同步（10 语言） ==')
    patch_translations()
    for lang in ('de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh-Hant'):
        patch_locale(lang)
    print('== 完成 ==')
    return 0


if __name__ == '__main__':
    sys.exit(main())