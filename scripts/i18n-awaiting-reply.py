#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v2.3.93 等待你回复提示 + 我不回复按钮：i18n 批量同步（locales/ 下 8 个 JSON）。

与 scripts/i18n-anim-trimode.py 同款做法：就地插入到 chat.idleCountdownTip 之后，
保持键序稳定（不重排整个文件），每种语言给真实翻译。
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES = os.path.join(ROOT, 'src', 'i18n', 'locales')

# 锚点键：新键插到它之后，保证与 translations.ts 的排列一致
ANCHOR = 'chat.idleCountdownTip'

# key -> 各语言真实翻译（顺序即插入顺序）
NEW = {
    'de': [
        ('chat.idleAwaiting', 'Gesendet · wartet auf deine Antwort'),
        ('chat.idleAwaitingTip', 'Eine proaktive Nachricht wurde gesendet. In diesem Chat wird keine weitere gesendet, bis du antwortest.'),
        ('chat.idleAwaitingSkip', 'Ich antworte nicht'),
        ('chat.idleAwaitingSkipTip', 'Als bereits beantwortet behandeln: Wartung aufheben und Timer für die nächste proaktive Nachricht ab jetzt neu starten'),
        ('chat.idleAwaitingSkipping', 'Wird ausgeführt…'),
        ('chat.idleAwaitingSkipFailed', 'Wartung konnte nicht aufgehoben werden. Bitte erneut versuchen.'),
    ],
    'es': [
        ('chat.idleAwaiting', 'Enviado · esperando tu respuesta'),
        ('chat.idleAwaitingTip', 'Se ha enviado un mensaje proactivo. No se enviará otro en este chat hasta que respondas.'),
        ('chat.idleAwaitingSkip', 'No voy a responder'),
        ('chat.idleAwaitingSkipTip', 'Tratarlo como ya respondido: cancela la espera y reinicia desde ahora el temporizador del próximo mensaje proactivo'),
        ('chat.idleAwaitingSkipping', 'Procesando…'),
        ('chat.idleAwaitingSkipFailed', 'No se pudo cancelar la espera. Inténtalo de nuevo.'),
    ],
    'fr': [
        ('chat.idleAwaiting', 'Envoyé · en attente de votre réponse'),
        ('chat.idleAwaitingTip', 'Un message proactif a été envoyé. Aucun autre ne sera envoyé dans cette conversation tant que vous ne répondez pas.'),
        ('chat.idleAwaitingSkip', 'Je ne réponds pas'),
        ('chat.idleAwaitingSkipTip', 'Traiter comme déjà répondu : annule l’attente et relance dès maintenant le minuteur du prochain message proactif'),
        ('chat.idleAwaitingSkipping', 'Traitement…'),
        ('chat.idleAwaitingSkipFailed', 'Impossible d’annuler l’attente. Veuillez réessayer.'),
    ],
    'ja': [
        ('chat.idleAwaiting', '送信済み · 返信を待っています'),
        ('chat.idleAwaitingTip', '自動メッセージを送信しました。このチャットでは、あなたが返信するまで次の自動メッセージは送信されません。'),
        ('chat.idleAwaitingSkip', '返信しない'),
        ('chat.idleAwaitingSkipTip', '返信済みとして扱う：待機を解除し、次の自動メッセージのタイマーを今この時点からやり直します'),

        ('chat.idleAwaitingSkipping', '処理中…'),
        ('chat.idleAwaitingSkipFailed', '待機を解除できませんでした。もう一度お試しください。'),
    ],
    'ko': [
        ('chat.idleAwaiting', '보냄 · 답변 대기 중'),
        ('chat.idleAwaitingTip', '자동 메시지가 전송되었습니다. 이 채팅에서는 답변하기 전까지 다음 자동 메시지가 전송되지 않습니다.'),
        ('chat.idleAwaitingSkip', '답변하지 않음'),
        ('chat.idleAwaitingSkipTip', '이미 답변한 것으로 처리: 대기를 해제하고 다음 자동 메시지 타이머를 지금부터 다시 시작합니다'),
        ('chat.idleAwaitingSkipping', '처리 중…'),
        ('chat.idleAwaitingSkipFailed', '대기를 해제하지 못했습니다. 다시 시도해 주세요.'),
    ],
    'pt': [
        ('chat.idleAwaiting', 'Enviada · aguardando sua resposta'),
        ('chat.idleAwaitingTip', 'Uma mensagem proativa foi enviada. Nenhuma outra será enviada nesta conversa até você responder.'),
        ('chat.idleAwaitingSkip', 'Não vou responder'),
        ('chat.idleAwaitingSkipTip', 'Tratar como já respondida: cancela a espera e reinicia agora o temporizador da próxima mensagem proativa'),
        ('chat.idleAwaitingSkipping', 'Processando…'),
        ('chat.idleAwaitingSkipFailed', 'Não foi possível cancelar a espera. Tente novamente.'),
    ],
    'ru': [
        ('chat.idleAwaiting', 'Отправлено · ожидает вашего ответа'),
        ('chat.idleAwaitingTip', 'Автосообщение отправлено. В этом чате новое не будет отправлено, пока вы не ответите.'),
        ('chat.idleAwaitingSkip', 'Не буду отвечать'),
        ('chat.idleAwaitingSkipTip', 'Считать, что ответ уже дан: снимает ожидание и сразу перезапускает таймер следующего автосообщения'),
        ('chat.idleAwaitingSkipping', 'Обработка…'),
        ('chat.idleAwaitingSkipFailed', 'Не удалось снять ожидание. Попробуйте ещё раз.'),
    ],
    'zh-Hant': [
        ('chat.idleAwaiting', '已傳送 · 正在等你回覆'),
        ('chat.idleAwaitingTip', '主動訊息已送出，在這個對話裡你回覆之前不會再發送下一條'),
        ('chat.idleAwaitingSkip', '我不回覆'),
        ('chat.idleAwaitingSkipTip', '按「已經回覆過了」處理：解除等待，下一條主動訊息從現在開始重新計時'),
        ('chat.idleAwaitingSkipping', '處理中…'),
        ('chat.idleAwaitingSkipFailed', '解除等待失敗，請重試'),
    ],
}


def insert_after_anchor(path, pairs):
    """把 pairs 逐条插到 ANCHOR 之后，保持其余键原位不动。"""
    with io.open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    data = json.loads(raw)
    before = len(data)
    if ANCHOR not in data:
        raise SystemExit('anchor %s missing in %s' % (ANCHOR, path))
    for k, v in pairs:
        data[k] = v  # 已存在则原地覆盖（幂等）
    # 重建顺序：原顺序 + 新键（按 pairs 顺序）插在 ANCHOR 之后
    order = list(data.keys())
    new_keys = [k for k, _ in pairs]
    # 移除旧位置（若之前已插入过，保证不重复）
    order = [k for k in order if k not in new_keys]
    idx = order.index(ANCHOR) + 1
    for offset, k in enumerate(new_keys):
        order.insert(idx + offset, k)
    ordered = {k: data[k] for k in order}
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(ordered, ensure_ascii=False, indent=2))
        f.write('\n')
    return before, len(ordered)


def main():
    for lang, pairs in sorted(NEW.items()):
        path = os.path.join(LOCALES, '%s.json' % lang)
        if not os.path.exists(path):
            print('SKIP (missing) %s' % path)
            continue
        before, after = insert_after_anchor(path, pairs)
        print('%-8s %4d -> %4d keys  (+%d)' % (lang, before, after, after - before))
    return 0


if __name__ == '__main__':
    sys.exit(main())
