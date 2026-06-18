import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 400),
      setTimeout(() => setPhase(2), 1200),
      setTimeout(() => setPhase(3), 2000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div className="absolute inset-0 flex items-center justify-between px-[15vw] z-10"
      initial={{ opacity: 0, x: '10vw' }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: '-10vw' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}>
      
      <div className="w-1/2">
        <h2 className="text-[4vw] font-bold font-display leading-tight mb-6">
          Загрузи <br/><span className="text-blue-500">два файла</span>
        </h2>
        <motion.p 
          className="text-[1.5vw] text-gray-400 border-l-4 border-blue-500 pl-4"
          initial={{ opacity: 0, height: 0 }}
          animate={phase >= 1 ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}>
          Прайс до 13 000 позиций + ваш список заказа
        </motion.p>
      </div>

      <div className="w-1/2 flex flex-col gap-6 items-end relative">
        <motion.div 
          className="w-[25vw] bg-[#1e293b] p-6 rounded-2xl border border-gray-700 shadow-2xl relative"
          initial={{ opacity: 0, y: 40, rotateX: -20 }}
          animate={phase >= 2 ? { opacity: 1, y: 0, rotateX: 0 } : { opacity: 0, y: 40, rotateX: -20 }}
          transition={{ type: 'spring', bounce: 0.4 }}>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-green-500/20 rounded flex items-center justify-center">
              <span className="text-green-500 font-bold">XLSX</span>
            </div>
            <div>
              <div className="text-xl font-bold">Прайс_Поставщика.xlsx</div>
              <div className="text-sm text-gray-400">13,492 строк</div>
            </div>
          </div>
        </motion.div>

        <motion.div 
          className="w-[25vw] bg-[#1e293b] p-6 rounded-2xl border border-gray-700 shadow-2xl relative"
          initial={{ opacity: 0, y: 40, rotateX: -20 }}
          animate={phase >= 3 ? { opacity: 1, y: 0, rotateX: 0 } : { opacity: 0, y: 40, rotateX: -20 }}
          transition={{ type: 'spring', bounce: 0.4, delay: 0.2 }}>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-500/20 rounded flex items-center justify-center">
              <span className="text-blue-500 font-bold">CSV</span>
            </div>
            <div>
              <div className="text-xl font-bold">Заказ_Q3.csv</div>
              <div className="text-sm text-gray-400">45 позиций</div>
            </div>
          </div>
        </motion.div>
      </div>

    </motion.div>
  );
}