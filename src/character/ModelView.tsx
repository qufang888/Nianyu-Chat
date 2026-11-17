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
  /**
   * 舞台缩放倍率（v3.0.3）。仅 3D / Live2D 需要它：位图与矢量靠 CSS 盒子放大即可，
   * 而 3D/Live2D 是**运行时渲染**的，必须自己提高渲染分辨率才能保持清晰。
   * 缺省 1 ⇒ 桌宠窗行为与改动前完全一致。
   */
  zoom?: number;
  /**
   * 纯渲染分辨率倍率（v3.0.6，只抬像素密度、不改模型尺寸）。
   * 桌宠窗传 `max(1.5, scale)` 以抵消 CSS transform:scale 的插值模糊；舞台不传（=1）。
   */
  resolutionScale?: number;
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
  zoom = 1,
  resolutionScale = 1,
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
    return (
      <Live2DView
        url={url}
        expression={expression}
        mouth={mouth}
        blink={blink}
        zoom={zoom}
        resolutionScale={resolutionScale}
        onError={onError}
      />
    );
  }

  if (character.kind === 'vrm' || character.kind === 'glb') {
    return (
      <ThreeModelView
        url={url}
        kind={character.kind}
        expression={expression}
        mouth={mouth}
        blink={blink}
        zoom={zoom}
        resolutionScale={resolutionScale}
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
