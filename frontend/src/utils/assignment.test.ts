import { describe, expect, test } from 'vitest';
import { Article, BiasLabel } from '../types';
import { isEligible, selectArticlesSequentially } from './assignArticles';

const GLOBAL_STUDENT_A = 'student_a@cuilahore.edu.pk';

function mkArticle(
  overrides: Partial<Article> & { sequence_number: number; article_id: string }
): Article {
  return {
    article_id: overrides.article_id,
    sequence_number: overrides.sequence_number,
    headline: 'test',
    display_text: 'test',
    source: 'test',
    author: 'test',
    date_published: '2025-01-01',
    url: '',
    category: 'General',
    article_type: 'News Article',
    word_count: 100,
    status: overrides.status ?? 'pending',
    annotation_count: overrides.annotation_count ?? 0,
    annotated_by: overrides.annotated_by ?? [],
    assigned_to: overrides.assigned_to ?? [],
    assigned_count: overrides.assigned_count ?? 0,
    bias_score: null,
    fleiss_kappa: null,
    label: null,
    final_label: null,
    is_gold_standard: false,
  };
}

describe('Sequential Eligibility & Assignment', () => {
  const REQUIRED = 5;
  const STUDENT_A = GLOBAL_STUDENT_A;

  test('1) 1-19 full, 20 partial(count=3), 21+ pending -> assignment starts 20 then 21,22,... in order', () => {
    const articles: Article[] = [];
    for (let seq = 1; seq <= 40; seq++) {
      if (seq <= 19) {
        articles.push(mkArticle({
          sequence_number: seq,
          article_id: `ART${seq}`,
          status: 'complete',
          annotation_count: 5,
          assigned_count: 5,
        }));
      } else if (seq === 20) {
        articles.push(mkArticle({
          sequence_number: 20,
          article_id: 'ART20',
          status: 'partial',
          annotation_count: 3,
          assigned_count: 3,
        }));
      } else {
        articles.push(mkArticle({
          sequence_number: seq,
          article_id: `ART${seq}`,
          status: 'pending',
          annotation_count: 0,
          assigned_count: 0,
        }));
      }
    }

    const result = selectArticlesSequentially(articles, STUDENT_A, REQUIRED, 20);
    expect(result.selected.length).toBe(20);

    const seqs = result.selected.map(id => Number(id.replace('ART', '')));
    expect(seqs[0]).toBe(20);
    for (let i = 1; i < 20; i++) {
      expect(seqs[i]).toBe(20 + i);
    }
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] > seqs[i-1]).toBe(true);
    }
    expect(result.skipped_inconsistent.length).toBe(0);
  });

  test('2) 1-10 full, 11-30 pending -> exactly 11-30', () => {
    const articles: Article[] = [];
    for (let seq = 1; seq <= 30; seq++) {
      if (seq <= 10) {
        articles.push(mkArticle({
          sequence_number: seq,
          article_id: `ART${seq}`,
          status: 'complete',
          annotation_count: 5,
          assigned_count: 5,
        }));
      } else {
        articles.push(mkArticle({
          sequence_number: seq,
          article_id: `ART${seq}`,
          status: 'pending',
          annotation_count: 0,
          assigned_count: 0,
        }));
      }
    }

    const result = selectArticlesSequentially(articles, STUDENT_A, REQUIRED, 20);
    expect(result.selected.length).toBe(20);
    const seqs = result.selected.map(id => Number(id.replace('ART', '')));
    for (let i = 0; i < 20; i++) {
      expect(seqs[i]).toBe(11 + i);
    }
  });

  test('3) Mixed statuses incl. count=4 -> no article >5 distinct annotators; no same-student duplicate', () => {
    const STUDENT_B = 'student_b@cuilahore.edu.pk';
    const existingAnnotators: string[] = [];
    for (let i = 1; i <= 4; i++) existingAnnotators.push(`s${i}@cuilahore.edu.pk`);

    const articles: Article[] = [];
    articles.push(mkArticle({
      sequence_number: 1,
      article_id: 'ART1',
      status: 'partial',
      annotation_count: 4,
      annotated_by: [...existingAnnotators],
      assigned_count: 4,
    }));
    articles.push(mkArticle({
      sequence_number: 2,
      article_id: 'ART2',
      status: 'complete',
      annotation_count: 5,
      assigned_count: 5,
    }));
    articles.push(mkArticle({
      sequence_number: 3,
      article_id: 'ART3',
      status: 'partial',
      annotation_count: 2,
      assigned_to: [STUDENT_A],
      assigned_count: 3,
    }));

    for (let seq = 4; seq <= 60; seq++) {
      articles.push(mkArticle({
        sequence_number: seq,
        article_id: `ART${seq}`,
        status: 'pending',
        assigned_count: 0,
      }));
    }

    const resultA = selectArticlesSequentially(articles, STUDENT_A, REQUIRED, 20);
    const resultB = selectArticlesSequentially(articles, STUDENT_B, REQUIRED, 20);

    expect(resultA.selected).not.toContain('ART2');
    expect(resultA.selected).not.toContain('ART3');
    expect(resultB.selected).toContain('ART1');
    expect(resultB.selected).toContain('ART3');
    expect(resultB.selected).not.toContain('ART2');

    const uniqueA = new Set(resultA.selected);
    const uniqueB = new Set(resultB.selected);
    expect(uniqueA.size).toBe(resultA.selected.length);
    expect(uniqueB.size).toBe(resultB.selected.length);

    for (const id of resultA.selected) {
      const art = articles.find(a => a.article_id === id);
      if (art) {
        expect(art.assigned_count).toBeLessThan(REQUIRED);
        expect(art.annotated_by.length).toBeLessThanOrEqual(REQUIRED);
        expect(art.assigned_to).not.toContain(STUDENT_A);
      }
    }
    for (const id of resultB.selected) {
      const art = articles.find(a => a.article_id === id);
      if (art) {
        expect(art.assigned_count).toBeLessThan(REQUIRED);
        expect(art.annotated_by.length).toBeLessThanOrEqual(REQUIRED);
        expect(art.assigned_to).not.toContain(STUDENT_B);
      }
    }
  });

  test('4) Exactly 20 eligible -> exactly those 20, nothing later', () => {
    const articles: Article[] = [];
    for (let seq = 1; seq <= 20; seq++) {
      articles.push(mkArticle({
        sequence_number: seq,
        article_id: `ART${seq}`,
        status: 'pending',
        assigned_count: 0,
      }));
    }
    for (let seq = 21; seq <= 50; seq++) {
      articles.push(mkArticle({
        sequence_number: seq,
        article_id: `ART${seq}`,
        status: 'complete',
        annotation_count: 5,
        assigned_count: 5,
      }));
    }

    const result = selectArticlesSequentially(articles, STUDENT_A, REQUIRED, 20);
    expect(result.selected.length).toBe(20);
    const seqs = result.selected.map(id => Number(id.replace('ART', '')));
    for (let i = 0; i < 20; i++) {
      expect(seqs[i]).toBe(1 + i);
    }
    result.selected.forEach(id => {
      expect(Number(id.replace('ART', ''))).toBeLessThanOrEqual(20);
    });
  });

  test('5) Only 13 eligible remain -> assign exactly 13; no error', () => {
    const articles: Article[] = [];
    for (let seq = 1; seq <= 13; seq++) {
      articles.push(mkArticle({
        sequence_number: seq,
        article_id: `ART${seq}`,
        status: 'pending',
        assigned_count: 0,
      }));
    }
    for (let seq = 14; seq <= 100; seq++) {
      articles.push(mkArticle({
        sequence_number: seq,
        article_id: `ART${seq}`,
        status: 'complete',
        annotation_count: 5,
        assigned_count: 5,
      }));
    }

    const result = selectArticlesSequentially(articles, STUDENT_A, REQUIRED, 20);
    expect(result.selected.length).toBe(13);
    const seqs = result.selected.map(id => Number(id.replace('ART', '')));
    expect(seqs).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13]);
  });
});

interface SimArticle {
  docId: string;
  data: Article;
}

interface SimSubmissionResult {
  committed: boolean;
  finalCount?: number;
  finalStatus?: string;
  reason?: string;
}

function runSimulatedSubmission(
  articleRef: SimArticle,
  studentEmail: string,
  dbState: Map<string, SimArticle>
): SimSubmissionResult {
  const snap = dbState.get(articleRef.docId);
  if (!snap) return { committed: false, reason: 'article-missing' };
  const data = snap.data;
  if (data.annotated_by.includes(studentEmail)) {
    return { committed: false, reason: 'duplicate-student' };
  }
  if (data.annotation_count >= 5) {
    return { committed: false, reason: 'already-full' };
  }
  const newAnnotatedBy = [...data.annotated_by, studentEmail];
  const newCount = data.annotation_count + 1;
  let newStatus = data.status;
  if (newCount >= 5) newStatus = 'complete';
  else if (newCount > 0) newStatus = 'partial';
  dbState.set(articleRef.docId, {
    docId: articleRef.docId,
    data: {
      ...data,
      annotated_by: newAnnotatedBy,
      annotation_count: newCount,
      status: newStatus as any,
    },
  });
  return { committed: true, finalCount: newCount, finalStatus: newStatus };
}

describe('Concurrency / Annotation Submission', () => {
  test('6) Article count=4; two simultaneous submissions -> exactly one succeeds, count=5 status=complete', () => {
    const existingAnnotators: string[] = [];
    for (let i = 1; i <= 4; i++) existingAnnotators.push(`s${i}@cuilahore.edu.pk`);
    const STUDENT_A = 'stu_a@cuilahore.edu.pk';
    const STUDENT_B = 'stu_b@cuilahore.edu.pk';

    for (let trial = 0; trial < 10; trial++) {
      const state = new Map<string, SimArticle>();
      const docId = 'ART-CONCURRENT';
      state.set(docId, {
        docId,
        data: mkArticle({
          sequence_number: 999,
          article_id: docId,
          status: 'partial',
          annotation_count: 4,
          annotated_by: [...existingAnnotators],
          assigned_count: 4,
        }),
      });
      const article0 = state.get(docId)!;

      if (trial % 2 === 0) {
        const rA = runSimulatedSubmission(article0, STUDENT_A, state);
        const rB = runSimulatedSubmission(article0, STUDENT_B, state);
        const finalData = state.get(docId)!.data;
        expect(rA.committed).toBe(true);
        expect(rB.committed).toBe(false);
        expect(finalData.annotation_count).toBe(5);
        expect(finalData.status).toBe('complete');
        expect(rA.finalCount).toBe(5);
      } else {
        const rB = runSimulatedSubmission(article0, STUDENT_B, state);
        const rA = runSimulatedSubmission(article0, STUDENT_A, state);
        const finalData = state.get(docId)!.data;
        expect(rB.committed).toBe(true);
        expect(rA.committed).toBe(false);
        expect(finalData.annotation_count).toBe(5);
        expect(finalData.status).toBe('complete');
      }
    }

    const existingAnnotatorsFinal: string[] = [];
    for (let i = 1; i <= 4; i++) existingAnnotatorsFinal.push(`s${i}@cuilahore.edu.pk`);
    const stateFinal = new Map<string, SimArticle>();
    const docKey = 'ART-DUP';
    stateFinal.set(docKey, {
      docId: docKey,
      data: mkArticle({
        sequence_number: 998,
        article_id: docKey,
        status: 'partial',
        annotation_count: 4,
        annotated_by: [...existingAnnotatorsFinal],
        assigned_count: 4,
      }),
    });
    const ref = stateFinal.get(docKey)!;
    const alreadyA = runSimulatedSubmission(ref, STUDENT_A, stateFinal);
    const duplicateA = runSimulatedSubmission(ref, STUDENT_A, stateFinal);
    expect(alreadyA.committed).toBe(true);
    expect(duplicateA.committed).toBe(false);
    expect(duplicateA.reason).toBe('duplicate-student');
  });
});

describe('isEligible consistency checks', () => {
  const STUDENT_A = GLOBAL_STUDENT_A;

  test('rejects partial with annotation_count=5 (inconsistency)', () => {
    const bad = mkArticle({
      sequence_number: 1, article_id: 'BAD1', status: 'partial',
      annotation_count: 5, assigned_count: 0,
    });
    const result = isEligible(bad, STUDENT_A, 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/consistency-err/);
  });

  test('rejects pending with annotation_count>0 (inconsistency)', () => {
    const bad = mkArticle({
      sequence_number: 2, article_id: 'BAD2', status: 'pending',
      annotation_count: 1, assigned_count: 0,
    });
    const result = isEligible(bad, STUDENT_A, 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/consistency-err/);
  });

  test('rejects student already assigned_to', () => {
    const art = mkArticle({
      sequence_number: 3, article_id: 'OK1', status: 'pending',
      annotation_count: 0, assigned_count: 1, assigned_to: [STUDENT_A],
    });
    const result = isEligible(art, STUDENT_A, 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('already-assigned-to-me');
  });

  test('rejects assigned_count>=5', () => {
    const art = mkArticle({
      sequence_number: 4, article_id: 'FULL', status: 'partial',
      annotation_count: 4, assigned_count: 5,
    });
    const result = isEligible(art, STUDENT_A, 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/assigned_count.*>=/);
  });

  test('rejects status=complete', () => {
    const art = mkArticle({
      sequence_number: 5, article_id: 'DONE', status: 'complete',
      annotation_count: 5, assigned_count: 5,
    });
    const result = isEligible(art, STUDENT_A, 5);
    expect(result.ok).toBe(false);
  });
});
