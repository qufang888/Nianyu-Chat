import React, { useEffect, useState } from 'react';
import { api } from '../ipc';
import { useI18n } from '../i18n/I18nContext';

interface ImageGridProps {
  paths: string[];
  onImage: (src: string) => void;
  failed?: boolean;
}

// 微信风格图片气泡：仅渲染图片本身（无绿色气泡背景），支持多图网格
const ImageGrid: React.FC<ImageGridProps> = ({ paths, onImage, failed }) => {
  const { t } = useI18n();
  const imgs = paths.filter(Boolean);
  if (imgs.length === 0) return null;

  const single = imgs.length === 1;
  let cols = 3;
  if (imgs.length === 2) cols = 2;
  else if (imgs.length === 3) cols = 3;
  else if (imgs.length === 4) cols = 2;
  else cols = 3;

  return (
    <div
      className={`image-grid ${single ? 'image-grid-single' : ''} ${failed ? 'image-grid-failed' : ''}`}
      style={single ? undefined : { gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {imgs.map((p, i) => (
        <ImageCell key={i} path={p} onImage={onImage} single={single} loadingText={t('chat.imageLoading')} />
      ))}
    </div>
  );
};

const ImageCell: React.FC<{ path: string; onImage: (src: string) => void; single: boolean; loadingText: string }> = ({
  path,
  onImage,
  single,
  loadingText,
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(path);
  useEffect(() => {
    let alive = true;
    api.getImage(path).then((s) => {
      if (alive) setSrc(s);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  if (!src) return <span className="img-loading">{loadingText}</span>;
  if (isVideo) {
    return (
      <video
        className={`img-cell ${single ? 'img-cell-single' : ''}`}
        src={src}
        controls
        playsInline
        preload="metadata"
      />
    );
  }
  return (
    <img
      className={`img-cell ${single ? 'img-cell-single' : ''}`}
      src={src}
      alt=""
      onClick={() => onImage(src)}
    />
  );
};

export default ImageGrid;
