// 角色渲染分发（V3）：按角色类型挑渲染器。
//
// - placeholder：原创几何占位形象（默认角色，不依赖任何外部素材）
// - image / sprite：静态立绘（png/jpg/webp/gif…）
// - live2d：Cubism 4 / Cubism 2 模型（需要用户自备运行时，见 Live2DView 注释）
// - vrm / glb：3D 模型（three + three-vrm）
//
// 素材统一走 nychar:// 私有协议，路径相对 <数据目录>/characters/<id>/。
import React, { useState } from 'react';
import type { DesktopCharacter } from '../types';
import { PlaceholderCharacter, type CharacterExpression } from './PlaceholderCharacter';
import { ThreeModelView } from './ThreeModelView';
import { Live2DView } from './Live2DView';

interface Props {
  character: DesktopCharacter;
  expression: CharacterExpression;
  mouth?: number;
  blink: boolean;
  dragging: boolean;
  /** 视线跟随（仅原创占位形象有效；图片/模型不跟随） */
  eyeX?: number;
  eyeY?: number;
  /** 渲染失败时回传原因（界面据此显示提示，而不是空白） */
  onError?: (message: string) => void;
}

/** 角色素材 URL：nychar://model/<id>/<相对路径> */
export function charAssetUrl(c: DesktopCharacter, rel?: string): string {
  const entry = rel || c.entry || (c.files && c.files[0]);
  if (!entry) return '';
  const segs = entry.split('/').filter(Boolean).map((s) => encodeURIComponent(s));
  return `nychar://model/${c.id}/${segs.join('/')}`;
}

export const ModelView: React.FC<Props> = ({
  character,
  expression,
  mouth = 0,
  blink,
  dragging,
  eyeX = 0,
  eyeY = 0,
  onError,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const url = charAssetUrl(character);

  // 没有可用素材（占位角色 / 旧版本只登记了名字）→ 一律回落到原创占位形象
  if (character.kind === 'placeholder' || !url || imgFailed) {
    return (
      <PlaceholderCharacter expression={expression} blink={blink} eyeX={eyeX} eyeY={eyeY} dragging={dragging} />
    );
  }

  if (character.kind === 'live2d') {
    return <Live2DView url={url} expression={expression} mouth={mouth} blink={blink} onError={onError} />;
  }

  if (character.kind === 'vrm' || character.kind === 'glb') {
    return (
      <ThreeModelView
        url={url}
        kind={character.kind}
        expression={expression}
        mouth={mouth}
        blink={blink}
        onError={onError}
      />
    );
  }

  return (
    <img
      className="dc-modelimg"
      src={url}
      alt={character.name}
      draggable={false}
      onError={() => {
        setImgFailed(true);
        onError?.('image load failed');
      }}
    />
  );
};

export default ModelView;
