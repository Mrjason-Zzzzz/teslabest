import React from 'react';

interface Props {
  videoUrl: string;
  className?: string;
}

const TVNativeVideo: React.FC<Props> = ({ videoUrl, className }) => {
  const playerUrl = `https://player.dorezst.cn/player.html?url=${encodeURIComponent(videoUrl)}`;

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
