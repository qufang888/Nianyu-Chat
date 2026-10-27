#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2.3.94 需求 1/2/3 i18n 批量同步（10 处：translations.ts 的 zh/en + locales 下 8 个 JSON）。

与 scripts/i18n-awaiting-reply.py / i18n-anim-trimode.py 同款做法：
就地插入到锚点键之后，保持键序稳定（不重排整个文件），每种语言给真实翻译。

本批新增键（需求 1 从此处开启新对话 / 需求 3 选取文字复制 / 需求 2 提示）：
  msg.forkFromHere        从此处开启新对话
  msg.forkFailStreaming   生成中的消息暂不能作为分叉点
  msg.selectCopy          选取文字复制
  msg.selectCopyTitle     选取文字复制
  msg.selectCopyHint      在下方文本框里拖动鼠标选取想复制的文字，然后点「复制选中」
  msg.copySelected        复制选中
  msg.copied              已复制
  toast.copyFailed        复制失败：{msg}
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES = os.path.join(ROOT, 'src', 'i18n', 'locales')
TRANS = os.path.join(ROOT, 'src', 'i18n', 'translations.ts')

# 锚点键：新键插到它之后，保证与 translations.ts 的排列一致
ANCHOR = 'msg.copy'

# key -> 各语言真实翻译（顺序即插入顺序）
NEW = {
    'zh': [
        ('msg.forkFromHere', '从此处开启新对话'),
        ('msg.forkFailStreaming', '这条消息还在生成中，生成完成后才能从这里开启新对话'),
        ('msg.selectCopy', '选取文字复制'),
        ('msg.selectCopyTitle', '选取文字复制'),
        ('msg.selectCopyHint', '在下方文本框里拖动鼠标选取想复制的文字，再点「复制选中」；不选则复制全部。'),
        ('msg.copySelected', '复制选中'),
        ('msg.copied', '已复制'),
        ('toast.copyFailed', '复制失败：{msg}'),
        ('settings.idleAwaitingThreshold', "触发等待的主动消息条数"),
        ('settings.idleAwaitingThresholdDesc', "主动消息发到这么多条后才开始「等你回复」；期间继续发。在你回复最后一条主动消息之前，不会再发新的主动消息。填 9999（或最大值）= 不启用等待功能。"),
        ('settings.idleAwaitingThresholdOff', "不启用等待功能（无限条）"),
        ('settings.idleAwaitingThresholdOn', "发满 {n} 条后开始等待回复"),
        ('memory.whyTitle', "为什么记忆是空的？"),
        ('memory.why.autoOff', "「设置 → 社交 → AI 自动提炼记忆」尚未开启"),
        ('memory.why.longOffAll', "所有聊天都没开「长记忆」开关（需在每个聊天的「⋯ 其他操作」里单独打开）"),
        ('memory.why.longOnSome', "目前有 {n} 个聊天开了长记忆"),
        ('memory.why.needRounds', "自动记忆每累计 10 轮对话才提炼一次，不足 10 轮不会有记忆"),
        ('memory.whyHowto', "想立刻看到记忆：在聊天里选中文字 → 右键「一键记忆」，或打开该聊天的长记忆后点「✨ AI 总结记忆」。"),
    ],
    'en': [
        ('msg.forkFromHere', 'Start a new chat from here'),
        ('msg.forkFailStreaming', 'This message is still generating; you can branch from it once it finishes'),
        ('msg.selectCopy', 'Select and copy text'),
        ('msg.selectCopyTitle', 'Select and copy text'),
        ('msg.selectCopyHint', 'Drag to select the text you want in the box below, then click "Copy selection". Select nothing to copy all.'),
        ('msg.copySelected', 'Copy selection'),
        ('msg.copied', 'Copied'),
        ('toast.copyFailed', 'Copy failed: {msg}'),
        ('settings.idleAwaitingThreshold', "Messages before waiting for your reply"),
        ('settings.idleAwaitingThresholdDesc', "Proactive messages keep sending until this many are sent, then the app starts waiting for your reply. No new proactive messages are sent until you reply to the last one. Set 9999 (or the max) to disable waiting entirely."),
        ('settings.idleAwaitingThresholdOff', "Waiting disabled (unlimited)"),
        ('settings.idleAwaitingThresholdOn', "Starts waiting after {n} messages"),
        ('memory.whyTitle', "Why is memory empty?"),
        ('memory.why.autoOff', "\"Settings → Social → AI auto-extract memory\" is off"),
        ('memory.why.longOffAll', "No chat has \"long memory\" enabled (turn it on per chat under \"⋯ More actions\")"),
        ('memory.why.longOnSome', "Long memory is on for {n} chat(s)"),
        ('memory.why.needRounds', "Auto memory runs once every 10 conversation rounds — fewer than 10 yields nothing"),
        ('memory.whyHowto', "To see memory right away: select text in a chat → right-click \"Save as memory\", or enable long memory in that chat then click \"✨ Summarize memory\"."),
    ],
    'zh-Hant': [
        ('msg.forkFromHere', '從此處開啟新對話'),
        ('msg.forkFailStreaming', '這條訊息還在生成中，生成完成後才能從這裡開啟新對話'),
        ('msg.selectCopy', '選取文字複製'),
        ('msg.selectCopyTitle', '選取文字複製'),
        ('msg.selectCopyHint', '在下方文字方塊裡拖動滑鼠選取想複製的文字，再點「複製選中」；不選則複製全部。'),
        ('msg.copySelected', '複製選中'),
        ('msg.copied', '已複製'),
        ('toast.copyFailed', '複製失敗：{msg}'),
        ('settings.idleAwaitingThreshold', "觸發等待的主動訊息條數"),
        ('settings.idleAwaitingThresholdDesc', "主動訊息發到這麼多條後才開始「等你回覆」；期間繼續發。在你回覆最後一條主動訊息之前，不會再發新的主動訊息。填 9999（或最大值）= 不啟用等待功能。"),
        ('settings.idleAwaitingThresholdOff', "不啟用等待功能（無限條）"),
        ('settings.idleAwaitingThresholdOn', "發滿 {n} 條後開始等待回覆"),
        ('memory.whyTitle', "為什麼記憶是空的？"),
        ('memory.why.autoOff', "「設定 → 社交 → AI 自動提煉記憶」尚未開啟"),
        ('memory.why.longOffAll', "所有聊天都沒開「長記憶」開關（需在每個聊天的「⋯ 其他操作」裡單獨打開）"),
        ('memory.why.longOnSome', "目前有 {n} 個聊天開了長記憶"),
        ('memory.why.needRounds', "自動記憶每累計 10 輪對話才提煉一次，不足 10 輪不會有記憶"),
        ('memory.whyHowto', "想立刻看到記憶：在聊天裡選取文字 → 右鍵「一鍵記憶」，或開啟該聊天的長記憶後點「✨ AI 總結記憶」。"),
    ],
    'ja': [
        ('msg.forkFromHere', 'ここから新しいチャットを開始'),
        ('msg.forkFailStreaming', 'このメッセージは生成中です。完了してから分岐できます'),
        ('msg.selectCopy', 'テキストを選択してコピー'),
        ('msg.selectCopyTitle', 'テキストを選択してコピー'),
        ('msg.selectCopyHint', '下のテキスト欄でドラッグしてコピーしたい文字を選び、「選択をコピー」をクリックします。選択しない場合はすべてコピーします。'),
        ('msg.copySelected', '選択をコピー'),
        ('msg.copied', 'コピーしました'),
        ('toast.copyFailed', 'コピーに失敗しました：{msg}'),
        ('settings.idleAwaitingThreshold', "返信待ちになるまでのメッセージ数"),
        ('settings.idleAwaitingThresholdDesc', "この数に達するまで能从なメッセージが送信され、その後返信待ちになります。最後の1件に返信するまで新しいメッセージは送信されません。9999（最大値）で待機機能を無効化します。"),
        ('settings.idleAwaitingThresholdOff', "待機なし（無制限）"),
        ('settings.idleAwaitingThresholdOn', "{n} 通で返信待ちを開始"),
        ('memory.whyTitle', "記憶が空なのはなぜ？"),
        ('memory.why.autoOff', "「設定 → ソーシャル → AI 自動抽出メモリ」がオフです"),
        ('memory.why.longOffAll', "どのチャットでも「ロングメモリ」が有効になっていません（各チャットの「⋯ その他の操作」で個別にオンにしてください）"),
        ('memory.why.longOnSome', "現在 {n} 件のチャットでロングメモリが有効です"),
        ('memory.why.needRounds', "自動メモリは 10 ターンの会話ごとに 1 回だけ抽出されます"),
        ('memory.whyHowto', "すぐに記憶を見たい場合：チャット内のテキストを選択して右クリック「記憶として保存」、またはロングメモリをオンにして「✨ AI 要約」を押してください。"),
    ],
    'ko': [
        ('msg.forkFromHere', '여기서 새 대화 시작'),
        ('msg.forkFailStreaming', '이 메시지는 아직 생성 중입니다. 생성이 끝나면 분기할 수 있습니다'),
        ('msg.selectCopy', '텍스트 선택 복사'),
        ('msg.selectCopyTitle', '텍스트 선택 복사'),
        ('msg.selectCopyHint', '아래 상자에서 드래그해 복사할 텍스트를 선택한 뒤 "선택 복사"를 클릭하세요. 선택하지 않으면 전체를 복사합니다.'),
        ('msg.copySelected', '선택 복사'),
        ('msg.copied', '복사됨'),
        ('toast.copyFailed', '복사 실패: {msg}'),
        ('settings.idleAwaitingThreshold', "답변 대기까지 메시지 수"),
        ('settings.idleAwaitingThresholdDesc', "이 수에 도달할 때까지 能동 메시지가 계속 전송된 후 답변을 기다립니다. 마지막 메시지에 답변하기 전까지 새 메시지는 전송되지 않습니다. 9999(최대값)는 대기 기능을 끕니다."),
        ('settings.idleAwaitingThresholdOff', "대기 비활성화(무제한)"),
        ('settings.idleAwaitingThresholdOn', "{n}개 후 대기 시작"),
        ('memory.whyTitle', "기억이 비어 있는 이유"),
        ('memory.why.autoOff', "\"설정 → 소셜 → AI 자동 기억 추출\"이 꺼져 있습니다"),
        ('memory.why.longOffAll', "어떤 채팅에서도 \"장기 기억\"이 켜져 있지 않습니다 (각 채팅의 \"⋯ 기타 작업\"에서 개별적으로 켜야 합니다)"),
        ('memory.why.longOnSome', "현재 {n}개의 채팅에서 장기 기억이 켜져 있습니다"),
        ('memory.why.needRounds', "자동 기억은 대화 10턴마다 한 번씩만 추출됩니다"),
        ('memory.whyHowto', "지금 바로 기억을 보고 싶다면: 채팅에서 텍스트 선택 → 우클릭 \"기억으로 저장\", 또는 장기 기억을 켜고 \"✨ AI 요약\"을 누르세요."),
    ],
    'de': [
        ('msg.forkFromHere', 'Neuen Chat von hier starten'),
        ('msg.forkFailStreaming', 'Diese Nachricht wird noch erzeugt; du kannst erst danach abzweigen'),
        ('msg.selectCopy', 'Text auswählen und kopieren'),
        ('msg.selectCopyTitle', 'Text auswählen und kopieren'),
        ('msg.selectCopyHint', 'Markiere unten per Ziehen den gewünschten Text und klicke auf "Auswahl kopieren". Ohne Auswahl wird alles kopiert.'),
        ('msg.copySelected', 'Auswahl kopieren'),
        ('msg.copied', 'Kopiert'),
        ('toast.copyFailed', 'Kopieren fehlgeschlagen: {msg}'),
        ('settings.idleAwaitingThreshold', "Nachrichten bis zum Warten auf deine Antwort"),
        ('settings.idleAwaitingThresholdDesc', "Proaktivnachrichten werden gesendet, bis diese Anzahl erreicht ist, danach wartet die App auf deine Antwort. Es werden keine neuen gesendet, bis du auf die letzte geantwortet hast. 9999 (oder Max) deaktiviert das Warten ganz."),
        ('settings.idleAwaitingThresholdOff', "Warten deaktiviert (unbegrenzt)"),
        ('settings.idleAwaitingThresholdOn', "Warten startet nach {n} Nachrichten"),
        ('memory.whyTitle', "Warum ist das Gedächtnis leer?"),
        ('memory.why.autoOff', "\"Einstellungen → Soziales → KI-Memory automatisch\" ist aus"),
        ('memory.why.longOffAll', "In keinem Chat ist \"Langzeitgedächtnis\" aktiviert (pro Chat unter \"⋯ Weitere Aktionen\" einschalten)"),
        ('memory.why.longOnSome', "Langzeitgedächtnis ist in {n} Chat(s) aktiv"),
        ('memory.why.needRounds', "Automatische Memory läuft erst alle 10 Gesprächsrunden"),
        ('memory.whyHowto', "Sofort Memory ansehen: Text im Chat markieren → Rechtsklick \"Als Memory speichern\", oder Langzeitgedächtnis einschalten und \"✨ KI zusammenfassen\" klicken."),
    ],
    'fr': [
        ('msg.forkFromHere', 'Commencer une nouvelle discussion ici'),
        ('msg.forkFailStreaming', 'Ce message est encore en cours de génération ; vous pourrez le scinder une fois terminé'),
        ('msg.selectCopy', 'Sélectionner et copier le texte'),
        ('msg.selectCopyTitle', 'Sélectionner et copier le texte'),
        ('msg.selectCopyHint', 'Faites glisser dans la zone ci-dessous pour sélectionner le texte à copier, puis cliquez sur « Copier la sélection ». Sans sélection, tout est copié.'),
        ('msg.copySelected', 'Copier la sélection'),
        ('msg.copied', 'Copié'),
        ('toast.copyFailed', 'Échec de la copie : {msg}'),
        ('settings.idleAwaitingThreshold', "Messages avant attente de votre réponse"),
        ('settings.idleAwaitingThresholdDesc', "Les messages proactifs continueront jusqu'à atteindre ce nombre, puis l'application attendra votre réponse. Aucun nouveau message n'est envoyé tant que vous n'avez pas répondu au dernier. 9999 (ou le max) désactive complètement l'attente."),
        ('settings.idleAwaitingThresholdOff', "Attente désactivée (illimité)"),
        ('settings.idleAwaitingThresholdOn', "Attente après {n} messages"),
        ('memory.whyTitle', "Pourquoi la mémoire est-elle vide ?"),
        ('memory.why.autoOff', "\"Paramètres → Social → Extraction auto par IA\" est désactivée"),
        ('memory.why.longOffAll', "Aucune discussion n'a la \"mémoire longue\" activée (à activer par discussion via \"⋯ Autres actions\")"),
        ('memory.why.longOnSome', "La mémoire longue est active dans {n} discussion(s)"),
        ('memory.why.needRounds', "L'extraction automatique ne s'exécute qu'une fois toutes les 10 tours"),
        ('memory.whyHowto', "Pour voir la mémoire tout de suite : sélectionnez du texte dans une discussion → clic droit « Enregistrer comme mémoire », ou activez la mémoire longue puis cliquez sur « ✨ Résumer par IA »."),
    ],
    'es': [
        ('msg.forkFromHere', 'Iniciar un chat nuevo desde aquí'),
        ('msg.forkFailStreaming', 'Este mensaje aún se está generando; podrás bifurcarlo cuando termine'),
        ('msg.selectCopy', 'Seleccionar y copiar texto'),
        ('msg.selectCopyTitle', 'Seleccionar y copiar texto'),
        ('msg.selectCopyHint', 'Arrastra en el cuadro de abajo para seleccionar el texto que quieres copiar y pulsa «Copiar selección». Si no seleccionas nada, se copia todo.'),
        ('msg.copySelected', 'Copiar selección'),
        ('msg.copied', 'Copiado'),
        ('toast.copyFailed', 'Error al copiar: {msg}'),
        ('settings.idleAwaitingThreshold', "Mensajes antes de esperar tu respuesta"),
        ('settings.idleAwaitingThresholdDesc', "Los mensajes proactivos seguirán enviándose hasta alcanzar esta cantidad; después la app esperará tu respuesta. No se enviarán nuevos hasta que respondas al último. 9999 (o el máximo) desactiva la espera por completo."),
        ('settings.idleAwaitingThresholdOff', "Espera desactivada (ilimitado)"),
        ('settings.idleAwaitingThresholdOn', "Empieza a esperar tras {n} mensajes"),
        ('memory.whyTitle', "¿Por qué la memoria está vacía?"),
        ('memory.why.autoOff', "\"Ajustes → Social → Extracción automática con IA\" está desactivada"),
        ('memory.why.longOffAll', "Ningún chat tiene activada la \"memoria a largo plazo\" (actívala por chat en \"⋯ Más acciones\")"),
        ('memory.why.longOnSome', "La memoria a largo plazo está activa en {n} chat(s)"),
        ('memory.why.needRounds', "La memoria automática se ejecuta solo cada 10 turnos de conversación"),
        ('memory.whyHowto', "Para ver memoria ahora: selecciona texto en un chat → clic derecho «Guardar como memoria», o activa la memoria a largo plazo y pulsa «✨ Resumir con IA»."),
    ],
    'pt': [
        ('msg.forkFromHere', 'Iniciar um novo chat a partir daqui'),
        ('msg.forkFailStreaming', 'Esta mensagem ainda está sendo gerada; você poderá bifurcar quando terminar'),
        ('msg.selectCopy', 'Selecionar e copiar texto'),
        ('msg.selectCopyTitle', 'Selecionar e copiar texto'),
        ('msg.selectCopyHint', 'Arraste na caixa abaixo para selecionar o texto que deseja copiar e clique em "Copiar seleção". Sem seleção, copia tudo.'),
        ('msg.copySelected', 'Copiar seleção'),
        ('msg.copied', 'Copiado'),
        ('toast.copyFailed', 'Falha ao copiar: {msg}'),
        ('settings.idleAwaitingThreshold', "Mensagens antes de esperar sua resposta"),
        ('settings.idleAwaitingThresholdDesc', "As mensagens proativas continuam sendo enviadas até atingir esta quantidade; depois o app passa a esperar sua resposta. Nenhuma nova mensagem é enviada até você responder à última. 9999 (ou o máximo) desativa a espera totalmente."),
        ('settings.idleAwaitingThresholdOff', "Espera desativada (ilimitado)"),
        ('settings.idleAwaitingThresholdOn', "Começa a esperar após {n} mensagens"),
        ('memory.whyTitle', "Por que a memória está vazia?"),
        ('memory.why.autoOff', "\"Configurações → Social → Extração automática por IA\" está desligada"),
        ('memory.why.longOffAll', "Nenhum chat tem a \"memória de longo prazo\" ativada (ative por chat em \"⋯ Mais ações\")"),
        ('memory.why.longOnSome', "A memória de longo prazo está ativa em {n} chat(s)"),
        ('memory.why.needRounds', "A memória automática roda a cada 10 turnos de conversa"),
        ('memory.whyHowto', "Para ver memória agora: selecione texto em um chat → clique direito em \"Salvar como memória\", ou ative a memória de longo prazo e clique em \"✨ Resumir com IA\"."),
    ],
    'ru': [
        ('msg.forkFromHere', 'Начать новый чат отсюда'),
        ('msg.forkFailStreaming', 'Это сообщение ещё генерируется; ответвление станет доступно после завершения'),
        ('msg.selectCopy', 'Выделить и скопировать текст'),
        ('msg.selectCopyTitle', 'Выделить и скопировать текст'),
        ('msg.selectCopyHint', 'Выделите нужный текст в поле ниже и нажмите «Копировать выделение». Если ничего не выделено, будет скопировано всё.'),
        ('msg.copySelected', 'Копировать выделение'),
        ('msg.copied', 'Скопировано'),
        ('toast.copyFailed', 'Не удалось скопировать: {msg}'),
        ('settings.idleAwaitingThreshold', "Сообщений до ожидания ответа"),
        ('settings.idleAwaitingThresholdDesc', "Проактивные сообщения будут отправляться, пока не наберётся указанное количество, затем приложение будет ждать вашего ответа. Новые сообщения не отправляются, пока вы не ответите на последнее. 9999 (или максимум) полностью отключает ожидание."),
        ('settings.idleAwaitingThresholdOff', "Ожидание отключено (без ограничений)"),
        ('settings.idleAwaitingThresholdOn', "Ожидание начинается после {n} сообщений"),
        ('memory.whyTitle', "Почему память пуста?"),
        ('memory.why.autoOff', "«Настройки → Социальные → Автоизвлечение памяти ИИ» выключено"),
        ('memory.why.longOffAll', "Ни в одном чате не включена «долгая память» (включается для каждого чата через «⋯ Другие действия»)"),
        ('memory.why.longOnSome', "Долгая память включена в {n} чатах"),
        ('memory.why.needRounds', "Автопамять срабатывает раз в 10 раундов разговора"),
        ('memory.whyHowto', "Чтобы сразу увидеть память: выделите текст в чате → правый клик «Сохранить в память», либо включите долгую память и нажмите «✨ Суммировать ИИ»."),
    ],
}

# locales JSON 与 translations.ts 内联 key 的对应关系
JSON_FILE = {
    'zh-Hant': 'zh-Hant.json',
    'ja': 'ja.json',
    'ko': 'ko.json',
    'de': 'de.json',
    'fr': 'fr.json',
    'es': 'es.json',
    'pt': 'pt.json',
    'ru': 'ru.json',
}


def insert_after(dic, anchor, pairs):
    """在 dict 中把 pairs 插到 anchor 键之后；anchor 不存在则追加到末尾。"""
    out = {}
    done = False
    for k, v in dic.items():
        out[k] = v
        if k == anchor:
            for nk, nv in pairs:
                # 幂等：已存在则不覆盖（避免重复运行时污染）
                if nk not in dic:
                    out[nk] = nv
            done = True
    if not done:
        for nk, nv in pairs:
            if nk not in out:
                out[nk] = nv
    return out


def write_json(path, data):
    # 沿用既有格式：2 空格缩进、ensure_ascii=False、CRLF 行尾
    with io.open(path, 'w', encoding='utf-8', newline='\r\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def main():
    # ---- 1) locales 下 8 个 JSON ----
    for lang, fname in JSON_FILE.items():
        path = os.path.join(LOCALES, fname)
        with io.open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        before = len(data)
        data = insert_after(data, ANCHOR, NEW[lang])
        write_json(path, data)
        added = len(data) - before
        print('%-10s %+d keys (total %d)' % (fname, added, len(data)))

    # ---- 2) translations.ts 的 zh / en 两段 ----
    with io.open(TRANS, 'r', encoding='utf-8', newline='') as f:
        src = f.read()

    for lang in ('zh', 'en'):
        marker = "\r\n  %s: {" % lang if '\r\n' in src else "\n  %s: {" % lang
        start = src.index(marker) + len(marker)
        # 该段的结束：下一个 "\n  <lang>: {" 或文件末尾的 "\n};"
        nxt = src.find(marker, start)
        end = nxt if nxt > 0 else src.rindex('\r\n};') if '\r\n' in src else src.rindex('\n};')
        seg = src[start:end]

        added = 0
        for key, val in NEW[lang]:
            # 幂等：段内已有该 key 就跳过
            if ("'%s':" % key) in seg:
                continue
            # 插到锚点之后（锚点是该段最后一个已插入键时也能正确处理）
            anchor_line = "    '%s':" % ANCHOR
            ai = seg.index(anchor_line)
            nl = seg.index('\n', ai)
            entry = "\r\n    '%s': %s," % (key, json.dumps(val, ensure_ascii=False))
            seg = seg[:nl] + entry + seg[nl:]
            added += 1

        src = src[:start] + seg + src[end:]
        print('%-10s +%d keys' % ('translations ' + lang, added))

    with io.open(TRANS, 'w', encoding='utf-8', newline='') as f:
        f.write(src)
    print('done')
    return 0


if __name__ == '__main__':
    sys.exit(main())