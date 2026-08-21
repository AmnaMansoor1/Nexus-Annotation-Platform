import { describe, expect, test } from "vitest";
import { reconcileArticle, AnnotatorContext } from "./reconcileArticle";

const LIVE = new Set(["a@test.com", "b@test.com"]);

function ctxFromLive(live: Set<string>, overrides?: Map<string, Set<string>>): AnnotatorContext {
  const articlesByAssignee = new Map<string, Set<string>>();
  if (overrides) {
    for (const [k, v] of overrides) articlesByAssignee.set(k, new Set(v));
  }
  return { liveEmails: new Set(live), articlesByAssignee };
}

describe("reconcileArticle self-heal", () => {
  test("drops deleted annotator from assigned_to and fixes assigned_count (backward-compat Set API)", () => {
    const result = reconcileArticle(
      {
        article_id: "ART1",
        assigned_to: ["a@test.com", "deleted@test.com", "b@test.com"],
        annotated_by: [],
        assigned_count: 5,
        annotation_count: 0,
        status: "pending",
      },
      LIVE,
      5
    );
    expect(result.needsPersist).toBe(true);
    expect(result.article.assigned_count).toBe(2);
    expect(result.article.assigned_to).toEqual(["a@test.com", "b@test.com"]);
  });

  test("fixes partial status when annotation_count becomes 0 (backward-compat Set API)", () => {
    const result = reconcileArticle(
      {
        article_id: "ART2",
        assigned_to: ["a@test.com"],
        annotated_by: ["ghost@test.com"],
        assigned_count: 1,
        annotation_count: 1,
        status: "partial",
      },
      LIVE,
      5
    );
    expect(result.article.annotation_count).toBe(0);
    expect(result.article.status).toBe("pending");
    expect(result.needsPersist).toBe(true);
  });

  test("no persist when already consistent (backward-compat Set API)", () => {
    const result = reconcileArticle(
      {
        article_id: "ART3",
        assigned_to: ["a@test.com"],
        annotated_by: [],
        assigned_count: 1,
        annotation_count: 0,
        status: "pending",
      },
      LIVE,
      5
    );
    expect(result.needsPersist).toBe(false);
  });

  test("AnnotatorContext.articlesByAssignee overrides stale article.assigned_to (truth from annotator docs)", () => {
    const ctx = ctxFromLive(
      new Set(["ann1@x.com", "ann2@x.com", "ann3@x.com"]),
      new Map([
        ["ART_GHOST", new Set(["ann1@x.com", "ann2@x.com"])],
      ])
    );
    const result = reconcileArticle(
      {
        article_id: "ART_GHOST",
        assigned_to: ["ghost1@x.com", "ghost2@x.com", "ghost3@x.com", "ghost4@x.com", "ann2@x.com"],
        annotated_by: [],
        assigned_count: 5,
        annotation_count: 0,
        status: "complete",
      },
      ctx,
      5
    );
    expect(result.needsPersist).toBe(true);
    expect(result.article.assigned_count).toBe(2);
    expect(new Set(result.article.assigned_to)).toEqual(new Set(["ann1@x.com", "ann2@x.com"]));
    expect(result.article.status).toBe("pending");
  });

  test("AnnotatorContext.articlesByAssignee falls back to live-filter when truth map is empty for article", () => {
    const ctx = ctxFromLive(new Set(["live1@x.com", "live2@x.com"]));
    const result = reconcileArticle(
      {
        article_id: "ART_NO_TRUTH",
        assigned_to: ["live1@x.com", "deleted@x.com", "live2@x.com"],
        annotated_by: [],
        assigned_count: 3,
        annotation_count: 0,
        status: "pending",
      },
      ctx,
      5
    );
    expect(result.needsPersist).toBe(true);
    expect(result.article.assigned_count).toBe(2);
    expect(new Set(result.article.assigned_to)).toEqual(new Set(["live1@x.com", "live2@x.com"]));
  });

  test("clears bias_score / fleiss_kappa / final_label when annotation_count drops below required", () => {
    const ctx = ctxFromLive(new Set(["a@x.com"]), new Map([
      ["ART_SCORES", new Set(["a@x.com"])],
    ]));
    const result = reconcileArticle(
      {
        article_id: "ART_SCORES",
        assigned_to: ["a@x.com", "deleted@x.com"],
        annotated_by: [],
        assigned_count: 2,
        annotation_count: 2,
        status: "complete",
        bias_score: 3.5,
        fleiss_kappa: 0.81,
        final_label: "Slightly Biased",
      } as any,
      ctx,
      5
    );
    expect(result.needsPersist).toBe(true);
    expect((result.article as any).bias_score).toBeNull();
    expect((result.article as any).fleiss_kappa).toBeNull();
    expect((result.article as any).final_label).toBeNull();
    expect(result.article.status).toBe("pending");
  });

  test("deduplicates and normalizes emails (case + whitespace)", () => {
    const ctx = ctxFromLive(new Set(["A@test.com"]), new Map([
      ["ART_DUP", new Set(["  A@TEST.COM  "])],
    ]));
    const result = reconcileArticle(
      {
        article_id: "ART_DUP",
        assigned_to: ["  a@test.com  ", "A@TEST.COM", "a@test.com"],
        annotated_by: [],
        assigned_count: 3,
        annotation_count: 0,
        status: "pending",
      },
      ctx,
      5
    );
    expect(result.article.assigned_count).toBe(1);
    expect(result.article.assigned_to).toEqual(["a@test.com"]);
  });
});
