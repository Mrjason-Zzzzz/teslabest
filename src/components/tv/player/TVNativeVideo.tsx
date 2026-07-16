import React from 'react';

// 扩展 Props 以兼容 page.tsx 传进来的所有属性
interface Props {
  url: string;
  sourceType?: string;
  poster?: string;
  live?: boolean;
  title?: string;
  onError?: () => void;
  className?: string;
}

const TVNativeVideo: React.FC<Props> = ({ url, className }) => {
  // 注意：这里用 url 参数来构建地址
  const playerUrl = `https://player.dorezst.cn/player.html?url=${encodeURIComponent(url)}`;

  return (
    <div className={`relative w-full h-full ${className}`}>
      <iframe 
        src={playerUrl}
        className="w-full h-full border-0"
        allow="autoplay; encrypted-media; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title="TV Player Sandbox"
      />
    </div>
  );
};

export default TVNativeVideo;
