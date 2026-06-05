import { useEffect, useState } from "react";

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

  useEffect(() => {
    if (timeLeft <= 0) {
      onComplete();
      return;
    }

    const timer = setInterval(() => {
      setTimeLeft((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [timeLeft, onComplete]);

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
