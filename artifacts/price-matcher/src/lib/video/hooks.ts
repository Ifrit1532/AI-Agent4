import { useState, useEffect } from 'react';

export function useVideoPlayer({ durations }: { durations: Record<string, number> }) {
  const [currentScene, setCurrentScene] = useState(0);

  useEffect(() => {
    window.startRecording?.();
    const durationValues = Object.values(durations);
    let isActive = true;
    let currentIdx = 0;
    let stopFired = false;

    const advanceScene = () => {
      if (!isActive) return;
      const duration = durationValues[currentIdx];
      setTimeout(() => {
        if (!isActive) return;
        currentIdx++;
        if (currentIdx >= durationValues.length) {
          if (!stopFired) {
            stopFired = true;
            window.stopRecording?.();
          }
          currentIdx = 0;
        }
        setCurrentScene(currentIdx);
        advanceScene();
      }, duration);
    };

    advanceScene();

    return () => {
      isActive = false;
    };
  }, []);

  return { currentScene };
}
