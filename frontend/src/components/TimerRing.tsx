import { useEffect, useRef, useState } from "react";

interface TimerRingProps {
  duration: number;
  startTime?: number;
  onComplete: () => void;
}

export default function TimerRing({ duration, startTime, onComplete }: TimerRingProps) {
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const completedFiredRef = useRef(false);

  const getEffectiveStart = () => (typeof startTime === "number" && startTime > 0 ? startTime : Date.now());

  const calcRemaining = (startMs: number) => {
    const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
    return Math.max(0, duration - elapsedSec);
  };

  const [timeLeft, setTimeLeft] = useState(() => calcRemaining(getEffectiveStart()));

  const strokeWidth = 4;
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (timeLeft / duration) * circumference;

  useEffect(() => {
    completedFiredRef.current = false;
    const startMs = getEffectiveStart();
    const initialRemaining = calcRemaining(startMs);
    setTimeLeft(initialRemaining);

    if (initialRemaining <= 0) {
      completedFiredRef.current = true;
      try {
        onCompleteRef.current();
      } catch {}
      return;
    }

    const interval = setInterval(() => {
      const remaining = calcRemaining(startMs);
      setTimeLeft(remaining);

      if (remaining <= 0) {
        if (!completedFiredRef.current) {
          completedFiredRef.current = true;
          try {
            onCompleteRef.current();
          } catch {}
        }
      }
    }, 200);

    return () => {
      clearInterval(interval);
    };
  }, [duration, startTime]);

  // Safety fallback: if timeLeft ever hits 0 and completion hasn't fired
  useEffect(() => {
    if (timeLeft <= 0 && !completedFiredRef.current) {
      completedFiredRef.current = true;
      try {
        onCompleteRef.current();
      } catch {}
    }
  }, [timeLeft]);

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg className="w-12 h-12 transform -rotate-90">
        <circle
          cx="24"
          cy="24"
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          fill="transparent"
          className="text-slate-100"
        />
        <circle
          cx="24"
          cy="24"
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          fill="transparent"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="text-primary transition-all duration-300 ease-linear"
        />
      </svg>
      <span className="absolute text-sm font-bold text-primary">{timeLeft}s</span>
    </div>
  );
}
