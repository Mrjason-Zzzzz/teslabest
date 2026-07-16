// TVNativeVideo.tsx (片段)
const playerUrl = `https://player.dorezst.cn?url=${encodeURIComponent(videoUrl)}`;

return (
  <iframe 
    src={playerUrl}
    className="w-full h-full border-0"
    allow="autoplay; encrypted-media; fullscreen"
    sandbox="allow-scripts allow-same-origin allow-forms"
  />
);
