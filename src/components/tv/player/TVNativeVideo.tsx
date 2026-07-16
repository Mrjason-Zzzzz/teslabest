import React from 'react';

// 添加了 sourceType 和 live 属性，彻底匹配 page.tsx 的调用
interface Props {
  url: string;
  sourceType?: any;
  live?: boolean;
  poster?: string;
  title?: string;
  onTime?: (current: number, duration: number) => void;
  command?: number;
  startTime?: number;
  onError?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  onBufferingChange?: (buffering: boolean) => void;
  adFilterEnabled?: boolean;
  playbackRate?: number;
  className?: string;
}

const TVNativeVideo: React.FC<Props> = ({ url, className }) => {
  // 核心：构建沙箱 URL
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
