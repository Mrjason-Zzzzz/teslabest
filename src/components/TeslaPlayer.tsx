'use client';
import { useEffect, useState } from 'react';

export default function TeslaPlayer() {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // 检查脚本是否已经存在，防止重复加载
    if (document.querySelector('script[src="/dist/index.js"]')) {
      setIsLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = '/dist/index.js'; // 告诉浏览器去 public 文件夹下拿这个文件
    script.async = true;
    script.onload = () => setIsLoaded(true);
    script.onerror = () => console.error("播放器脚本加载失败");
    
    document.body.appendChild(script);

    return () => {
      // 严苛要求：在组件卸载时移除脚本，避免内存泄漏
      // document.body.removeChild(script); 
    };
  }, []);

  if (!isLoaded) return <div>播放器加载中...</div>;

  return (
    <div>
      {/* 在这里调用你的播放器，通常它会挂载到 window 对象上 */}
      {/* 例如: <div id="tesla-player-container"></div> */}
      <h1>播放器已就绪</h1>
    </div>
  );
}
