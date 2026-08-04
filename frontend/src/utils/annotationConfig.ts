import type { AdminConfig, Article } from "../types";

export const DEFAULT_REQUIRED_ANNOTATIONS = 5;

export function normalizeRequiredAnnotations(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_REQUIRED_ANNOTATIONS;

  const normalized = Math.floor(parsed);
  return normalized >= 2 ? normalized : DEFAULT_REQUIRED_ANNOTATIONS;
}

export function getRequiredAnnotations(
  article?: Partial<Article> | null,
  adminConfig?: Partial<AdminConfig> | null
): number {
  if (article && article.required_annotations != null) {
    return normalizeRequiredAnnotations(article.required_annotations);
  }

  if (adminConfig && adminConfig.annotators_per_article != null) {
    return normalizeRequiredAnnotations(adminConfig.annotators_per_article);
  }

  return DEFAULT_REQUIRED_ANNOTATIONS;
}
