import { Timestamp } from "firebase/firestore";

export type ArticleStatus = "pending" | "partial" | "complete";

export interface Article {
  article_id: string;
  headline: string;
  display_text: string;
  source: string;
  author: string;
  date_published: string;
  url: string;
  category: string;
  article_type: "News Article" | "Blog" | "Opinion";
  word_count: number;
  status: ArticleStatus;
  annotation_count: number;
  annotated_by: string[];
  assigned_to: string[];
  assigned_count: number;
  bias_score: number | null;
  fleiss_kappa: number | null;
  is_gold_standard: boolean;
  gold_expected_label?: BiasLabel;
}

export type BiasLabel = "neutral" | "slightly_manipulative" | "highly_manipulative";
export type BiasType = "political" | "emotional" | "factual" | "other";
export type ConfidenceLevel = "low" | "medium" | "high";

export interface AnnotationResponse {
  label: BiasLabel;
  bias_type: BiasType | null;
  confidence: ConfidenceLevel;
  timestamp: Timestamp;
  time_spent_sec: number;
  is_gold_check: boolean;
}

export interface Annotator {
  email: string;
  full_name: string;
  registration_code?: string;
  completed: boolean;
  deactivated?: boolean;
  completed_articles: string[];
  assigned_articles: string[];
  reliability_score: number;
  // Performance metrics
  gold_total_count?: number;
  gold_correct_count?: number;
  gold_accuracy?: number;
}

export interface AdminConfig {
  total_target: number;
  gold_article_ids: string[];
  annotators_per_article: number;
}

export interface PlatformSummary {
  totalArticles: number;
  completedArticles: number;
  pendingArticles: number;
  inProgressArticles: number;
  totalAnnotators: number;
  completedAnnotators: number;
  avgBiasScore: number;
  needsReview: number;
  categoryDistribution?: Record<string, number>;
}
