// 原创几何占位角色「小念」。
//
// 合规声明：本角色为念语团队原创的简单几何造型（圆润身体 + 豆豆眼 + 小围巾 + 触角），
// 与任何第三方桌面宠物/陪伴软件的角色形象与配色无关；仓库中不包含任何
// 第三方模型、贴图、逐帧动画或音频。用户可另行导入自己拥有权利的角色素材替换本占位角色。
import React from 'react';

export type CharacterExpression =
  | 'neutral'
  | 'happy'
  | 'angry'
  | 'shy'
  | 'surprised'
  | 'thinking'
  | 'wave'
  | 'nod'
  | 'shake'
  | 'yawn'
  | 'greet'
  | 'dragged';

export interface PlaceholderCharacterProps {
  expression: CharacterExpression;
  blink: boolean;
  /** 视线偏移（-1~1） */
  eyeX: number;
  eyeY: number;
  dragging: boolean;
}

const BODY = '#eef1f8';
const BODY_SHADE = '#dfe4ef';
const OUTLINE = '#c4cbdb';
const EYE = '#2b3140';
const CHEEK = '#ffb3c1';

function eyeOffset(expression: CharacterExpression): { x: number; y: number } {
  if (expression === 'shy') return { x: -2.2, y: 1.2 };
  if (expression === 'thinking') return { x: 2.4, y: -1.4 };
  if (expression === 'surprised') return { x: 0, y: -0.6 };
  return { x: 0, y: 0 };
}

export const PlaceholderCharacter: React.FC<PlaceholderCharacterProps> = ({
  expression,
  blink,
  eyeX,
  eyeY,
  dragging,
}) => {
  const closed = blink || expression === 'yawn';
  const happyEyes = expression === 'happy' || expression === 'greet' || expression === 'wave';
  const wideEyes = expression === 'surprised';
  const off = eyeOffset(expression);
  const px = Math.max(-3, Math.min(3, eyeX * 3 + off.x));
  const py = Math.max(-2.4, Math.min(2.4, eyeY * 2.4 + off.y));

  // 嘴型
  let mouth = 'M84 146 Q95 153 106 146'; // 微笑
  if (expression === 'angry') mouth = 'M84 151 Q95 143 106 151';
  else if (expression === 'shy') mouth = 'M88 147 Q95 151 102 147';
  else if (expression === 'surprised' || expression === 'yawn') mouth = 'M88 145 Q95 160 102 145 Q95 167 88 145';
  else if (expression === 'thinking') mouth = 'M87 148 L103 148';
  else if (expression === 'happy' || expression === 'greet') mouth = 'M82 145 Q95 158 108 145';

  // 眉毛（生气时下压、惊讶时上挑）
  const browY = expression === 'angry' ? 6 : expression === 'surprised' ? -6 : 0;
  const browTilt = expression === 'angry' ? 4 : 0;

  // 身体呼吸/动作
  const bodyScaleY = dragging ? 0.94 : 1;
  const bodyScaleX = dragging ? 1.06 : 1;
  const headShiftX = expression === 'shake' ? 3 : 0;
  const headShiftY = expression === 'nod' ? 4 : expression === 'dragged' ? 2 : 0;

  return (
    <svg className="dc-svg" viewBox="0 0 190 220" aria-hidden="true">
      <defs>
        <radialGradient id="dcBodyGrad" cx="50%" cy="38%" r="70%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor={BODY} />
        </radialGradient>
      </defs>

      {/* 地面阴影（原创几何） */}
      <ellipse cx="95" cy="206" rx="48" ry="8" fill="rgba(20,24,34,0.16)" />

      {/* 触角 */}
      <g className="dc-antenna">
        <path d="M95 66 C95 54 103 48 111 44" stroke={OUTLINE} strokeWidth="3" fill="none" strokeLinecap="round" />
        <circle cx="113" cy="43" r="6" fill="var(--color-primary)" opacity="0.9" />
        <circle cx="111" cy="41" r="2" fill="#ffffff" opacity="0.85" />
      </g>

      <g
        className="dc-body-group"
        style={{
          transform: `translate(${headShiftX}px, ${headShiftY}px) scale(${bodyScaleX}, ${bodyScaleY})`,
          transformOrigin: '95px 150px',
          transition: 'transform 220ms ease',
        }}
      >
        {/* 身体（圆润水滴） */}
        <path
          d="M95 62
             C131 62 158 88 158 128
             C158 168 130 196 95 196
             C60 196 32 168 32 128
             C32 88 59 62 95 62 Z"
          fill="url(#dcBodyGrad)"
          stroke={OUTLINE}
          strokeWidth="2.5"
        />
        {/* 肚皮浅色块 */}
        <ellipse cx="95" cy="160" rx="38" ry="28" fill="#ffffff" opacity="0.55" />

        {/* 围巾（主题主色，随主题变化） */}
        <path d="M58 132 Q95 148 132 132 L132 142 Q95 158 58 142 Z" fill="var(--color-primary)" opacity="0.9" />
        <path d="M120 140 L132 156 L122 158 L112 143 Z" fill="var(--color-primary)" opacity="0.75" />

        {/* 眉毛 */}
        <g stroke={EYE} strokeWidth="3.2" strokeLinecap="round" fill="none" opacity={expression === 'neutral' ? 0 : 0.85}>
          <path d={`M67 ${96 + browY} L79 ${96 + browY + browTilt}`} />
          <path d={`M111 ${96 + browY + browTilt} L123 ${96 + browY}`} />
        </g>

        {/* 眼睛 */}
        {happyEyes ? (
          <g stroke={EYE} strokeWidth="3.4" strokeLinecap="round" fill="none">
            <path d="M67 113 Q75 105 83 113" />
            <path d="M107 113 Q115 105 123 113" />
          </g>
        ) : closed ? (
          <g stroke={EYE} strokeWidth="3.4" strokeLinecap="round" fill="none">
            <path d="M67 111 L83 111" />
            <path d="M107 111 L123 111" />
          </g>
        ) : (
          <g>
            <ellipse cx="75" cy="111" rx={wideEyes ? 13 : 11} ry={wideEyes ? 15 : 13} fill="#ffffff" stroke={OUTLINE} strokeWidth="1.6" />
            <ellipse cx="115" cy="111" rx={wideEyes ? 13 : 11} ry={wideEyes ? 15 : 13} fill="#ffffff" stroke={OUTLINE} strokeWidth="1.6" />
            <circle cx={75 + px} cy={111 + py} r={wideEyes ? 5 : 4.6} fill={EYE} />
            <circle cx={115 + px} cy={111 + py} r={wideEyes ? 5 : 4.6} fill={EYE} />
            <circle cx={76.6 + px} cy={109 + py} r="1.5" fill="#ffffff" />
            <circle cx={116.6 + px} cy={109 + py} r="1.5" fill="#ffffff" />
          </g>
        )}

        {/* 腮红（害羞时更大） */}
        <ellipse cx="58" cy="132" rx={expression === 'shy' ? 10 : 7} ry={expression === 'shy' ? 6 : 4.6} fill={CHEEK} opacity="0.65" />
        <ellipse cx="132" cy="132" rx={expression === 'shy' ? 10 : 7} ry={expression === 'shy' ? 6 : 4.6} fill={CHEEK} opacity="0.65" />

        {/* 嘴 */}
        <path d={mouth} stroke={EYE} strokeWidth="2.6" fill="none" strokeLinecap="round" />
      </g>

      {/* 手（wave/greet 时一只举起） */}
      <g
        className="dc-arm"
        style={{
          transformOrigin: '150px 155px',
          transform: expression === 'wave' || expression === 'greet' ? 'rotate(-52deg)' : 'rotate(0deg)',
          transition: 'transform 260ms ease',
        }}
      >
        <rect x="146" y="150" width="12" height="30" rx="6" fill={BODY_SHADE} stroke={OUTLINE} strokeWidth="2" />
      </g>
      <g>
        <rect x="32" y="150" width="12" height="30" rx="6" fill={BODY_SHADE} stroke={OUTLINE} strokeWidth="2" />
      </g>

      {/* 脚 */}
      <ellipse cx="75" cy="196" rx="14" ry="8" fill={BODY_SHADE} stroke={OUTLINE} strokeWidth="2" />
      <ellipse cx="115" cy="196" rx="14" ry="8" fill={BODY_SHADE} stroke={OUTLINE} strokeWidth="2" />
    </svg>
  );
};

export default PlaceholderCharacter;
