'use client'; // 这一行是灵魂，强制 Next.js 只在浏览器加载此组件

import { useEffect, useRef } from 'react';

export default function TeslaPlayer({ url }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const initPlayer = async () => {
      // 使用动态导入，确保只在组件挂载到 DOM 后才去读取 JS 文件
      // 这里直接指向 /dist/index.js
      const { createTeslaPlayer } = await import('/dist/index.js');
      
      if (containerRef.current) {
        const player = createTeslaPlayer(containerRef.current, {
          decoderMode: 'auto',
          renderer: 'webgl',
          controls: true
        });

        // 加载流
        await player.load(url);
        await player.play();
      }
    };

    initPlayer();
  }, [url]);

  return <div ref={containerRef} style={{ width: '100%', height: '500px', backgroundColor: '#000' }} />;
}
