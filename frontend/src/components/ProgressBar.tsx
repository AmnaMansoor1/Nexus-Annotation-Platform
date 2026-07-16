interface ProgressBarProps {
  current: number;
  total: number;
}

export default function ProgressBar({ current, total }: ProgressBarProps) {
  // Clamp values so they can't exceed total or go below 0
  const clampedCurrent = Math.max(1, Math.min(current, total));
  const percentage = Math.max(0, Math.min((clampedCurrent / total) * 100, 100));

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-between text-sm font-semibold text-slate-500">
        <span>Article {clampedCurrent} of {total}</span>
        <span>{Math.round(percentage)}%</span>
      </div>
      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div 
          className="h-full bg-primary transition-all duration-500 ease-out rounded-full"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
