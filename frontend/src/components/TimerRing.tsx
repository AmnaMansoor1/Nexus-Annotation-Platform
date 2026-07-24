import { useEffect, useRef, useState } from "react";

interface TimerRingProps {
  duration: number;
  onComplete: () => void;
}

export default function TimerRing({ duration, onComplete }: TimerRingProps) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const strokeWidth = 4;
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (timeLeft / duration) * circumference;

  const firedRef = useRef(false);
  const activeRef = useRef(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    activeRef.current = true;
    firedRef.current = false;
    setTimeLeft(duration);

    intervalRef.current = setInterval(() => {
      if (!activeRef.current) return;
      setTimeLeft((prev) => {
        if (!activeRef.current) return prev;
        const next = prev - 1;
        return next < 0 ? 0 : next;
      });
    }, 1000);

    return () => {
      activeRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [duration]);

  useEffect(() => {
    if (timeLeft <= 0 && !firedRef.current) {
      firedRef.current = true;
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
          className="text-primary transition-all duration-1000 ease-linear"
        />
      </svg>
      <span className="absolute text-sm font-bold text-primary">{timeLeft}s</span>
    </div>
  );
}
