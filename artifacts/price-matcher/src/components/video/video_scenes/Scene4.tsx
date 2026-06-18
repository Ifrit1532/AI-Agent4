import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 1800),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div className="absolute inset-0 flex items-center px-[10vw] z-10"
      initial={{ opacity: 0, clipPath: 'polygon(0 0, 0 100%, 0 100%, 0 0)' }}
      animate={{ opacity: 1, clipPath: 'polygon(0 0, 0 100%, 100% 100%, 100% 0)' }}
      exit={{ opacity: 0, y: '-20vh' }}
      transition={{ duration: 1, ease: [0.76, 0, 0.24, 1] }}>
      
      <div className="w-1/2 pr-[5vw]">
        <h2 className="text-[4vw] font-bold font-display leading-tight mb-6">
          Не найдено? <br/>Правь <span className="text-amber-400">вручную</span>
        </h2>
        <p className="text-[1.5vw] text-gray-400">
          Живой поиск по артикулу прямо в интерфейсе
        </p>
      </div>

      <div className="w-1/2">
        <motion.div className="bg-[#1e293b] p-8 rounded-2xl border border-amber-500/30 shadow-2xl relative"
          initial={{ y: 50 }}
          animate={{ y: 0 }}
          transition={{ duration: 0.8 }}>
          
          <div className="flex items-center justify-between mb-6 pb-6 border-b border-gray-700">
            <div className="text-xl font-bold text-red-400">Специфичный Товар X</div>
            <div className="px-3 py-1 bg-red-500/20 text-red-400 text-sm rounded">Не найден</div>
          </div>

          <motion.div className="relative"
            initial={{ opacity: 0 }}
            animate={phase >= 1 ? { opacity: 1 } : { opacity: 0 }}>
            <div className="text-sm text-gray-400 mb-2">Поиск по прайсу...</div>
            <div className="flex items-center gap-3">
              <input type="text" className="bg-gray-900 border border-gray-600 rounded px-4 py-3 w-full text-white font-mono outline-none focus:border-amber-400" value="Товар X-123" readOnly />
            </div>
            
            <motion.div className="absolute w-full mt-2 bg-gray-800 border border-gray-600 rounded-lg overflow-hidden shadow-lg z-20"
              initial={{ opacity: 0, height: 0 }}
              animate={phase >= 2 ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}>
              <div className="p-3 border-b border-gray-700 hover:bg-gray-700 cursor-pointer">
                Товар X-123 (Модель A) - 1500 ₽
              </div>
              <div className="p-3 bg-amber-500/20 text-amber-300 border-b border-gray-700 font-bold flex justify-between">
                <span>Товар X-123 (Модель B) - 1650 ₽</span>
                <span>Выбрать ✓</span>
              </div>
            </motion.div>

          </motion.div>

        </motion.div>
      </div>

    </motion.div>
  );
}