import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600),
      setTimeout(() => setPhase(2), 1400),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div className="absolute inset-0 flex flex-col items-center justify-center z-10"
      initial={{ opacity: 0, scale: 1.2 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1, ease: 'easeOut' }}>
      
      <motion.div className="w-32 h-32 bg-green-500 rounded-full flex items-center justify-center mb-8 shadow-[0_0_50px_rgba(34,197,94,0.5)]"
        initial={{ scale: 0 }}
        animate={phase >= 1 ? { scale: 1 } : { scale: 0 }}
        transition={{ type: 'spring', bounce: 0.5 }}>
        <svg className="w-16 h-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      </motion.div>

      <h2 className="text-[5vw] font-bold font-display text-center leading-none mb-4">
        Скачай в Excel
      </h2>
      
      <motion.p className="text-[1.8vw] text-gray-400 mb-12"
        initial={{ opacity: 0 }}
        animate={phase >= 2 ? { opacity: 1 } : { opacity: 0 }}>
        Готовый результат с ценами и суммами
      </motion.p>

      <motion.div className="text-[2.5vw] font-bold text-white tracking-widest font-display"
        initial={{ opacity: 0, y: 20 }}
        animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
        transition={{ delay: 0.5 }}>
        AI УМНЫЙ ПОИСК ЦЕН
      </motion.div>
      
    </motion.div>
  );
}