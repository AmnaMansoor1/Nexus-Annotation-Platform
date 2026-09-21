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
    expect((result.article as any).label).toBeNull();
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

  describe("Issue-1: responseAnnotatorEmails union with raw.annotated_by (prevents deleted-annotator wipe)", () => {
    test("responseAnnotatorEmails RESTORES 4/5 annotations that were wiped by deleted-annotator filter", () => {
      // Simulate: 4 annotators (A,B,C,D) submitted, then they were deleted from
      // /annotators. reconcileArticle's old behavior would filter all 4 out of
      // raw.annotated_by → annotation_count=0, status=pending. CSV still shows
      // 4 responses in subcollection. New behavior UNIONS raw with responses.
      const ctx = ctxFromLive(new Set(["newuser@x.com"])); // only a new live user, all 4 are deleted
      const result = reconcileArticle(
        {
          article_id: "ART_RESPONSE_TRUTH",
          assigned_to: ["deleted1@x.com", "deleted2@x.com", "deleted3@x.com", "deleted4@x.com"],
          annotated_by: ["deleted1@x.com", "deleted2@x.com", "deleted3@x.com", "deleted4@x.com"],
          assigned_count: 4,
          annotation_count: 4,
          status: "partial",
        },
        ctx,
        5,
        {
          responseAnnotatorEmails: [
            "deleted1@x.com",
            "deleted2@x.com",
            "deleted3@x.com",
            "deleted4@x.com",
          ],
        }
      );
      // Even though all 4 are "deleted" from annotators, response docs still
      // exist physically → they count toward annotation_count.
      expect(result.article.annotation_count).toBe(4);
      expect(result.article.annotated_by.length).toBe(4);
      expect(result.article.status).toBe("partial");
      expect(result.needsPersist).toBe(true); // raw vs union changed
    });

    test("responseAnnotatorEmails UNION with raw.annotated_by merges disjoint sets", () => {
      const ctx = ctxFromLive(new Set(["a@x.com", "d@x.com"]));
      const result = reconcileArticle(
        {
          article_id: "ART_MERGE",
          assigned_to: ["a@x.com"],
          annotated_by: ["a@x.com"],
          assigned_count: 1,
          annotation_count: 1,
          status: "partial",
        },
        ctx,
        5,
        {
          // Responses contain a (already in raw) plus d (live) plus deleted b,c
          responseAnnotatorEmails: ["a@x.com", "b-deleted@x.com", "c-deleted@x.com", "d@x.com"],
        }
      );
      expect(result.article.annotation_count).toBe(4); // a,d from live ∪ b-deleted,c-deleted via responses
      expect(new Set(result.article.annotated_by).size).toBe(4);
      expect(result.article.status).toBe("partial");
    });

    test("responseAnnotatorEmails not passed → falls back to legacy filter behavior (backward compat)", () => {
      const ctx = ctxFromLive(new Set(["live1@x.com"])); // 3 deleted, only 1 lives
      const result = reconcileArticle(
        {
          article_id: "ART_FALLBACK",
          assigned_to: ["d1@x.com", "d2@x.com", "d3@x.com", "live1@x.com"],
          annotated_by: ["d1@x.com", "d2@x.com", "d3@x.com", "live1@x.com"],
          assigned_count: 4,
          annotation_count: 4,
          status: "partial",
        },
        ctx,
        5
      );
      // Legacy: only live annotators remain in annotation_count.
      expect(result.article.annotation_count).toBe(1);
      expect(result.article.annotated_by.length).toBe(1);
      expect(result.article.status).toBe("partial");
    });
  });
});
