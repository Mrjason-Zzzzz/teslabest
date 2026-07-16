'use client'; // 声明为客户端组件

import { useEffect, useState } from 'react';

// 1. 定义接口，确保 TypeScript 不再报错
interface TeslaPlayerProps {
  url: string;
}

export default function TeslaPlayer({ url }: TeslaPlayerProps) {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // 如果页面已经有这个脚本了，就不要重复加载
    if (document.querySelector('script[src="/dist/index.js"]')) {
      setIsLoaded(true);
      return;
    }

    // 动态加载 public/dist/index.js
    const script = document.createElement('script');
    script.src = '/dist/index.js';
    script.async = true;
    script.onload = () => {
      setIsLoaded(true);
      console.log("播放器脚本加载成功");
    };
    script.onerror = () => console.error("播放器脚本加载失败，请检查 public/dist/index.js 是否存在");
    
    document.body.appendChild(script);

    return () => {
      // 可以在这里选择移除脚本，或者保持它
    };
  }, []);

  // 当加载完成后，初始化播放器
  useEffect(() => {
    if (isLoaded) {
      // 注意：这里的 window.createTeslaPlayer 是假设你的库挂载在 window 上
      // 如果你的库导出方式不同（比如 export default），你需要在这里调整调用方式
      if (typeof window !== 'undefined' && (window as any).createTeslaPlayer) {
        const container = document.getElementById('tesla-player-container');
        if (container) {
          const player = (window as any).createTeslaPlayer(container, {
            decoderMode: 'auto',
            renderer: 'webgl',
            controls: true
          });
          player.load(url);
          player.play();
        }
      }
    }
  }, [isLoaded, url]);

  return (
    <div 
      id="tesla-player-container" 
      style={{ width: '100%', height: '500px', backgroundColor: '#000' }}
    >
      {!isLoaded && <p style={{ color: '#fff' }}>播放器加载中...</p>}
    </div>
  );
}
