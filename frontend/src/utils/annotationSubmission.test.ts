import { describe, expect, test, beforeEach, vi } from "vitest";
import { BiasLabel } from "../types";
import { calculateBiasScore } from "./calculateBiasScore";
import { calculateFleissKappa } from "./calculateKappa";

/**
 * Pure re-implementation of the NEW Issue-1 submission transaction rules
 * (moved into the Firestore transaction). We test the pure logical
 * decision rules here so failures show up quickly without needing
 * Firestore emulator.
 *
 * Input: prior article state + the submitting annotator email + their label
 * Output: the NEXT article state (status, annotation_count, annotated_by,
 * bias_score, fleiss_kappa, final_label) + whether the response record
 * would be written + whether it's a 5th-annotation completion.
 */

type ArticleState = {
  annotated_by: string[];
  annotation_count: number;
  status: "pending" | "partial" | "complete";
  bias_score: number | null;
  fleiss_kappa: number | null;
  final_label: BiasLabel | null;
  // Simulated prior responses (per-annotator label) so we can verify kappa/bias calc
  priorLabels: Array<{ email: string; label: BiasLabel }>;
};

const REQUIRED = 5;

function submitAnnotation(
  state: ArticleState,
  email: string,
  label: BiasLabel
): {
  next: ArticleState;
  responseWritten: boolean;
  justCompleted: boolean;
  doubleSubmitBlocked: boolean;
  fullBlocked: boolean;
} {
  const emailNorm = email.toLowerCase().trim();
  const priorAnnotatedNorm = state.annotated_by
    .map((e) => (typeof e === "string" ? e.toLowerCase().trim() : ""))
    .filter((e) => !!e);
  const priorSet = new Set(priorAnnotatedNorm);
  const priorDistinctCount = priorSet.size;

  if (priorSet.has(emailNorm)) {
    return { next: state, responseWritten: false, justCompleted: false, doubleSubmitBlocked: true, fullBlocked: false };
  }
  if (priorDistinctCount >= REQUIRED) {
    return { next: state, responseWritten: false, justCompleted: false, doubleSubmitBlocked: false, fullBlocked: true };
  }

  const newAnnotatedBy = Array.from(new Set([...priorAnnotatedNorm, emailNorm]));
  const newAnnotationCount = newAnnotatedBy.length;
  let newStatus: ArticleState["status"] = state.status;
  if (newAnnotationCount >= REQUIRED) newStatus = "complete";
  else if (newAnnotationCount > 0) newStatus = "partial";

  const next: ArticleState = {
    ...state,
    annotated_by: newAnnotatedBy,
    annotation_count: newAnnotationCount,
    status: newStatus,
    priorLabels: [...state.priorLabels, { email: emailNorm, label }],
  };

  let justCompleted = false;
  if (newStatus === "complete" && newAnnotationCount >= REQUIRED) {
    const counts = { neutral: 0, slightly: 0, highly: 0 };
    for (const r of next.priorLabels) {
      if (r.label === "neutral") counts.neutral++;
      else if (r.label === "slightly_manipulative") counts.slightly++;
      else if (r.label === "highly_manipulative") counts.highly++;
    }
    next.bias_score = calculateBiasScore(counts);
    next.fleiss_kappa = calculateFleissKappa(counts);
    const entries = (Object.entries(counts) as Array<[BiasLabel, number]>);
    entries.sort((a, b) => b[1] - a[1]);
    const [topLabel, topCount] = entries[0];
    const [_snd, secondCount] = entries[1];
    next.final_label = topCount > 0 && topCount !== secondCount ? topLabel : null;
    justCompleted = true;
  }
  return { next, responseWritten: true, justCompleted, doubleSubmitBlocked: false, fullBlocked: false };
}

function makeEmpty(): ArticleState {
  return {
    annotated_by: [],
    annotation_count: 0,
    status: "pending",
    bias_score: null,
    fleiss_kappa: null,
    final_label: null,
    priorLabels: [],
  };
}

function submitN(stateIn: ArticleState, pairs: Array<{ email: string; label: BiasLabel }>) {
  let s = stateIn;
  const completions: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const res = submitAnnotation(s, pairs[i].email, pairs[i].label);
    if (res.justCompleted) completions.push(i);
    s = res.next;
  }
  return { s, completions };
}

describe("Issue-1 submission transaction rules", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const LABELS: BiasLabel[] = ["neutral", "slightly_manipulative", "highly_manipulative"];

  test("TEST-1 4th→5th distinct annotation causes status to become complete AND writes all 3 score fields", () => {
    const { s } = submitN(makeEmpty(), [
      { email: "a@x.com", label: "neutral" },
      { email: "b@x.com", label: "neutral" },
      { email: "c@x.com", label: "neutral" },
      { email: "d@x.com", label: "slightly_manipulative" },
    ]);
    expect(s.status).toBe("partial");
    expect(s.annotation_count).toBe(4);
    expect(s.bias_score).toBeNull();
    expect(s.fleiss_kappa).toBeNull();

    const res = submitAnnotation(s, "e@x.com", "highly_manipulative");
    expect(res.justCompleted).toBe(true);
    expect(res.responseWritten).toBe(true);
    expect(res.next.status).toBe("complete");
    expect(res.next.annotation_count).toBe(5);
    expect(res.next.annotated_by.length).toBe(5);
    expect(typeof res.next.bias_score === "number").toBe(true);
    expect(typeof res.next.fleiss_kappa === "number").toBe(true);
    expect(typeof res.next.final_label === "string" && LABELS.includes(res.next.final_label)).toBe(true);
    expect(res.next.bias_score).not.toBeNull();
    expect(res.next.fleiss_kappa).not.toBeNull();
    expect(res.next.final_label).not.toBeNull();
  });

  test("TEST-2 5 responses with STALE INCORRECT article annotation_count still produces status=complete and scores written (authoritative count = distinct annotated_by)", () => {
    const stale: ArticleState = {
      annotated_by: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
      annotation_count: 3,    // STALE INCORRECT (should be 4)
      status: "partial",
      bias_score: null,
      fleiss_kappa: null,
      final_label: null,
      priorLabels: [
        { email: "a@x.com", label: "neutral" },
        { email: "b@x.com", label: "neutral" },
        { email: "c@x.com", label: "slightly_manipulative" },
        { email: "d@x.com", label: "slightly_manipulative" },
      ],
    };
    const res = submitAnnotation(stale, "e@x.com", "neutral");
    expect(res.next.status).toBe("complete");
    expect(res.next.annotation_count).toBe(5);
    expect(res.next.bias_score).not.toBeNull();
    expect(res.next.fleiss_kappa).not.toBeNull();
    expect(res.next.final_label).not.toBeNull();
    expect(res.next.final_label).toBe("neutral");
  });

  test("TEST-3 bias_score, fleiss_kappa, final_label correctly computed on 5th distinct annotator", () => {
    // 3 neutral + 1 slightly + 1 highly → majority = neutral (3 > 1, 1)
    const { s } = submitN(makeEmpty(), [
      { email: "a@x.com", label: "neutral" },
      { email: "b@x.com", label: "neutral" },
      { email: "c@x.com", label: "neutral" },
      { email: "d@x.com", label: "slightly_manipulative" },
      { email: "e@x.com", label: "highly_manipulative" },
    ]);
    expect(s.status).toBe("complete");
    expect(s.bias_score).toBe(calculateBiasScore({ neutral: 3, slightly: 1, highly: 1 }));
    expect(s.fleiss_kappa).toBe(calculateFleissKappa({ neutral: 3, slightly: 1, highly: 1 }));
    expect(s.final_label).toBe("neutral");
  });

  test("TEST-4 Same student cannot submit the same article twice — first counted, second silent-ignored (no double-count, no double completion)", () => {
    const first = submitAnnotation(makeEmpty(), "a@x.com", "neutral");
    expect(first.responseWritten).toBe(true);
    expect(first.next.annotation_count).toBe(1);
    expect(first.next.annotated_by).toEqual(["a@x.com"]);
    expect(first.doubleSubmitBlocked).toBe(false);

    const second = submitAnnotation(first.next, "a@x.com", "highly_manipulative");
    expect(second.doubleSubmitBlocked).toBe(true);
    expect(second.responseWritten).toBe(false);
    expect(second.next.annotation_count).toBe(1);
    expect(second.next.annotated_by).toEqual(["a@x.com"]);
    expect(second.next.priorLabels.length).toBe(1);
  });

  test("TEST-5 Transaction retry with same inputs → completion stats written exactly once (no double counting justCompleted on retry-idempotency)", () => {
    const start = makeEmpty();
    const five: Array<{ email: string; label: BiasLabel }> = [
      { email: "a@x.com", label: "neutral" },
      { email: "b@x.com", label: "neutral" },
      { email: "c@x.com", label: "neutral" },
      { email: "d@x.com", label: "slightly_manipulative" },
      { email: "e@x.com", label: "highly_manipulative" },
    ];
    const { s: firstRun, completions: c1 } = submitN(start, five);
    expect(firstRun.status).toBe("complete");
    expect(c1.length).toBe(1);
    expect(firstRun.annotation_count).toBe(5);

    // "Retry" — same 5 students submit again. All should be blocked as duplicate,
    // status stays complete, ZERO additional justCompleted events (prevents double-count of platform stats).
    const { s: secondRun, completions: c2 } = submitN(firstRun, five);
    expect(secondRun.status).toBe("complete");
    expect(secondRun.annotation_count).toBe(5);
    expect(c2.length).toBe(0);
  });
});
