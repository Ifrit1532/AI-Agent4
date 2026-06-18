import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video/hooks';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';

const SCENE_DURATIONS = { 
  open: 4000, 
  upload: 4500, 
  matching: 5000, 
  manual: 4500, 
  close: 4000 
};

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#0a0f1c] text-white">
      {/* Persistent Background Layer */}
      <div className="absolute inset-0 z-0">
        <motion.div className="absolute w-[80vw] h-[80vw] rounded-full opacity-20 blur-3xl"
          style={{ background: 'radial-gradient(circle, #1d4ed8, transparent)' }}
          animate={{ x: ['-20%', '20%', '-20%'], y: ['-10%', '10%', '-10%'], scale: [1, 1.2, 1] }}
          transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }} />
        <motion.div className="absolute w-[60vw] h-[60vw] rounded-full opacity-10 blur-3xl right-0 bottom-0"
          style={{ background: 'radial-gradient(circle, #059669, transparent)' }}
          animate={{ x: ['10%', '-10%', '10%'], y: ['10%', '-10%', '10%'] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut' }} />
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] opacity-10 mix-blend-overlay"></div>
      </div>

      <AnimatePresence mode="popLayout">
        {currentScene === 0 && <Scene1 key="open" />}
        {currentScene === 1 && <Scene2 key="upload" />}
        {currentScene === 2 && <Scene3 key="matching" />}
        {currentScene === 3 && <Scene4 key="manual" />}
        {currentScene === 4 && <Scene5 key="close" />}
      </AnimatePresence>
    </div>
  );
}