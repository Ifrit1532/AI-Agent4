import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div className="absolute inset-0 flex flex-col items-center justify-center px-[10vw] z-10"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, filter: 'blur(20px)' }}
      transition={{ duration: 0.8, ease: 'easeOut' }}>
      
      <h2 className="text-[3.5vw] font-bold font-display mb-12 text-center">
        ИИ находит <span className="text-emerald-400">совпадения</span>
      </h2>

      <div className="w-full bg-[#0f172a] border border-gray-800 rounded-xl overflow-hidden shadow-2xl">
        <div className="grid grid-cols-3 bg-[#1e293b] p-4 text-sm font-bold text-gray-400 border-b border-gray-800">
          <div>Искомый товар</div>
          <div className="text-center">Метод</div>
          <div>Найдено в прайсе</div>
        </div>
        
        <div className="flex flex-col">
          {[
            { q: 'Блок лазера Lexmark 40X8080', m: 'По коду', r: '40X8080 Laser Unit', p: phase >= 1, color: 'text-blue-400' },
            { q: 'Картридж HP 55A', m: 'По артикулу', r: 'CE255A HP LJ P3015', p: phase >= 2, color: 'text-purple-400' },
            { q: 'Бумага A4 500л', m: 'По названию', r: 'Бумага офисная А4 Снегурочка', p: phase >= 3, color: 'text-emerald-400' },
          ].map((row, i) => (
            <motion.div key={i} className="grid grid-cols-3 p-6 border-b border-gray-800/50 items-center bg-gray-900/50"
              initial={{ opacity: 0, x: -50 }}
              animate={row.p ? { opacity: 1, x: 0 } : { opacity: 0, x: -50 }}
              transition={{ type: 'spring', damping: 20 }}>
              <div className="text-lg">{row.q}</div>
              <div className="flex justify-center">
                <span className={`px-4 py-1 rounded-full text-sm border ${row.color} border-current bg-current/10`}>
                  {row.m}
                </span>
              </div>
              <div className="text-lg font-mono text-gray-300">{row.r}</div>
            </motion.div>
          ))}
        </div>
      </div>

    </motion.div>
  );
}