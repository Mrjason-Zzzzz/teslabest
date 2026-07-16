// 1. 在文件最上面引入你的组件
import TeslaPlayer from '@/components/TeslaPlayer';

// 2. 这是页面函数
export default function Home() {
  return (
    <main>
      <h1>我的特斯拉视频播放器</h1>
      {/* 3. 在这里使用组件 */}
      <TeslaPlayer url="https://你的视频流地址.flv" />
    </main>
  );
}
