import type { BiasLabel } from "../types";

const LABEL_PRIORITY: BiasLabel[] = [
  "highly_manipulative",
  "slightly_manipulative",
  "neutral",
];

export function formatBiasLabel(label: BiasLabel | null | undefined): string {
  switch (label) {
    case "highly_manipulative":
      return "highly_manipulative";
    case "slightly_manipulative":
      return "slightly_manipulative";
    case "neutral":
      return "neutral";
    default:
      return "";
  }
}

export function mapBiasLabelToBinary(label: BiasLabel | null | undefined): 0 | 1 | "" {
  if (!label) return "";
  return label === "neutral" ? 0 : 1;
}

export function formatBinaryBiasLabel(label: BiasLabel | null | undefined): "neutral" | "biased" | "" {
  if (!label) return "";
  return label === "neutral" ? "neutral" : "biased";
}

export function getMajorityBiasLabel(counts: {
  neutral: number;
  slightly: number;
  highly: number;
}): BiasLabel | null {
  const entries: Array<{ label: BiasLabel; count: number }> = [
    { label: "neutral", count: counts.neutral },
    { label: "slightly_manipulative", count: counts.slightly },
    { label: "highly_manipulative", count: counts.highly },
  ];

  const sorted = entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return LABEL_PRIORITY.indexOf(a.label) - LABEL_PRIORITY.indexOf(b.label);
  });

  if (!sorted[0] || sorted[0].count === 0) return null;
  return sorted[0].label;
}
