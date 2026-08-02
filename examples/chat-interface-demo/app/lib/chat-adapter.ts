import { getCatalog } from "./catalogs";
import type { ChatRequest, ChatResponse, TraceStage } from "./types";

const endpoint = process.env.NEXT_PUBLIC_ALTER_API_URL;

const mockResponse = async (request: ChatRequest): Promise<ChatResponse> => {
  const catalog = getCatalog(request.catalogId);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const adaptive = request.catalogId === "adaptive";
  const stages: TraceStage[] = [
    { id: "principal", label: "Principal", status: "complete", detail: "Prompt classified and isolated" },
    ...(adaptive
      ? [
          { id: "definition", label: "Definition alter", status: "complete" as const, detail: "Specialist catalog created privately" },
          { id: "specialist", label: "Dynamic specialist", status: "complete" as const, detail: "Scoped tool execution completed" },
        ]
      : [{ id: request.catalogId, label: catalog.name, status: "complete" as const, detail: "Catalog response completed" }]),
    { id: "relay", label: "Result relay", status: "complete", detail: "Validated output returned to chat" },
  ];
  const responseCopy = adaptive
    ? "The adaptive catalog created a private specialist definition, ran it in isolation, and relayed the validated result. Connect the runtime endpoint to replace this demonstration with a real alter trace."
    : `${catalog.name} received “${request.prompt.slice(0, 92)}${request.prompt.length > 92 ? "…" : ""}”. This response is coming from the demo adapter; the UI contract is ready for an alter-spawner backend.`;
  return {
    messageId: crypto.randomUUID(),
    content: responseCopy,
    trace: {
      runId: `run_${crypto.randomUUID().slice(0, 8)}`,
      catalogId: request.catalogId,
      status: "complete",
      durationMs: adaptive ? 4620 : 1370,
      tokens: adaptive ? 3884 : 1186,
      stages,
    },
  };
};

export const sendChat = async (request: ChatRequest): Promise<ChatResponse> => {
  if (!endpoint) return mockResponse(request);
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Alter runtime returned ${response.status}.`);
  return response.json() as Promise<ChatResponse>;
};
