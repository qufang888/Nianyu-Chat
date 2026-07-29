import { useEffect, useState } from 'react';

const api = (window as any).api;

interface Props {
  path: string;
  onRemove: () => void;
}

// 发送前「图片预览缩略图」：加载本地图片 data URL 并渲染，带移除按钮。
// 由 ChatWindow / MiniChat 在输入框正上方复用。
export default function PendingImageThumb({ path, onRemove }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (api && api.getImage) {
      api
        .getImage(path)
        .then((u: string | null) => {
          if (alive && u) setUrl(u);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <div className="img-thumb">
      {url ? <img src={url} alt="" /> : <div className="img-thumb-loading">…</div>}
      <button type="button" className="img-thumb-x" title="移除" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}
