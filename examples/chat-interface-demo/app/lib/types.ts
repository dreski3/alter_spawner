export type CatalogTone = "mint" | "amber" | "violet" | "blue";

export type AlterCatalog = {
  id: string;
  name: string;
  description: string;
  model: string;
  glyph: string;
  tone: CatalogTone;
};

export type TraceStage = {
  id: string;
  label: string;
  status: "queued" | "running" | "complete" | "failed";
  detail: string;
};

export type RunTrace = {
  runId: string;
  catalogId: string;
  status: "running" | "complete" | "failed";
  durationMs: number;
  tokens: number;
  stages: TraceStage[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  catalogId?: string;
  trace?: RunTrace;
};

export type ChatRequest = {
  prompt: string;
  catalogId: string;
  conversationId: string;
};

export type ChatResponse = {
  messageId: string;
  content: string;
  trace: RunTrace;
};
