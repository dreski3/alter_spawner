"use client";

import { FormEvent, KeyboardEvent, useMemo, useRef, useState } from "react";
import { ALTER_CATALOGS, getCatalog } from "./lib/catalogs";
import { sendChat } from "./lib/chat-adapter";
import type { ChatMessage, RunTrace } from "./lib/types";

const INITIAL_TRACE: RunTrace = {
  runId: "run_demo_001",
  catalogId: "general",
  status: "complete",
  durationMs: 1840,
  tokens: 1284,
  stages: [
    { id: "principal", label: "Principal", status: "complete", detail: "Prompt accepted" },
    { id: "general", label: "General alter", status: "complete", detail: "Response synthesized" },
  ],
};

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "Relay is ready. Choose an alter catalog and send a prompt—the active adapter will keep the UI contract stable while the runtime behind it changes.",
    createdAt: "14:32",
    catalogId: "general",
    trace: INITIAL_TRACE,
  },
];

const timeNow = () => new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date());

export default function Home() {
  const [catalogId, setCatalogId] = useState("general");
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [activeTrace, setActiveTrace] = useState<RunTrace>(INITIAL_TRACE);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const catalog = useMemo(() => getCatalog(catalogId), [catalogId]);
  const adapterMode = process.env.NEXT_PUBLIC_ALTER_API_URL ? "Live endpoint" : "Demo adapter";

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || pending) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: timeNow(),
    };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setPending(true);
    try {
      const response = await sendChat({ prompt, catalogId, conversationId: "demo-conversation" });
      const assistantMessage: ChatMessage = {
        id: response.messageId,
        role: "assistant",
        content: response.content,
        createdAt: timeNow(),
        catalogId,
        trace: response.trace,
      };
      setMessages((current) => [...current, assistantMessage]);
      setActiveTrace(response.trace);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: error instanceof Error ? error.message : "The adapter could not complete this run.",
          createdAt: timeNow(),
        },
      ]);
    } finally {
      setPending(false);
      requestAnimationFrame(() => textarea.current?.focus());
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <main className="app-shell">
      <aside className="catalog-panel">
        <div className="brand-lockup">
          <div className="brand-mark">N</div>
          <div>
            <p className="eyebrow">Naut</p>
            <h1>Relay</h1>
          </div>
        </div>

        <div className="panel-heading">
          <span>Alter catalogs</span>
          <span className="count">{ALTER_CATALOGS.length}</span>
        </div>
        <nav className="catalog-list" aria-label="Alter catalogs">
          {ALTER_CATALOGS.map((item) => (
            <button
              className={`catalog-card tone-${item.tone} ${catalogId === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => setCatalogId(item.id)}
              type="button"
              aria-pressed={catalogId === item.id}
            >
              <span className="catalog-glyph">{item.glyph}</span>
              <span className="catalog-copy">
                <strong>{item.name}</strong>
                <small>{item.description}</small>
              </span>
              <span className="catalog-arrow">›</span>
            </button>
          ))}
        </nav>

        <div className="connection-card">
          <div className="connection-row">
            <span className="status-dot" />
            <strong>{adapterMode}</strong>
          </div>
          <p>
            {adapterMode === "Demo adapter"
              ? "Local responses emulate the alter-spawner contract."
              : "Prompts are routed through the configured runtime endpoint."}
          </p>
          <code>{process.env.NEXT_PUBLIC_ALTER_API_URL || "mock://alter-runtime"}</code>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Active conversation</p>
            <h2>Runtime integration test</h2>
          </div>
          <div className="header-actions">
            <span className="isolation-chip"><i /> Context isolated</span>
            <button className="icon-button" type="button" aria-label="Start a new conversation" onClick={() => setMessages(INITIAL_MESSAGES)}>＋</button>
          </div>
        </header>

        <div className="conversation" aria-live="polite">
          <div className="date-divider"><span>Today</span></div>
          {messages.map((message) => {
            const messageCatalog = message.catalogId ? getCatalog(message.catalogId) : null;
            return (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-meta">
                  <span>{message.role === "user" ? "You" : message.role === "system" ? "System" : messageCatalog?.name || "Relay"}</span>
                  <time>{message.createdAt}</time>
                </div>
                <div className="message-bubble">
                  <p>{message.content}</p>
                  {message.trace && (
                    <button className="trace-link" type="button" onClick={() => setActiveTrace(message.trace!)}>
                      <span>↳</span> Inspect run · {message.trace.durationMs.toLocaleString()} ms
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {pending && (
            <article className="message assistant pending-message">
              <div className="message-meta"><span>{catalog.name}</span><time>running</time></div>
              <div className="message-bubble typing"><i /><i /><i /></div>
            </article>
          )}
        </div>

        <form className="composer" onSubmit={submit}>
          <div className="composer-topline">
            <button className={`active-catalog tone-${catalog.tone}`} type="button" aria-label={`Active catalog: ${catalog.name}`}>
              <span>{catalog.glyph}</span>{catalog.name}<b>⌄</b>
            </button>
            <span>Enter to send · Shift + Enter for a new line</span>
          </div>
          <div className="composer-box">
            <textarea
              ref={textarea}
              aria-label="Message the selected alter catalog"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={`Ask ${catalog.name.toLowerCase()} to handle a prompt…`}
              rows={3}
            />
            <button className="send-button" type="submit" disabled={!draft.trim() || pending} aria-label="Send message">
              <span>Send</span> ↗
            </button>
          </div>
        </form>
      </section>

      <aside className="trace-panel">
        <div className="trace-header">
          <div>
            <p className="eyebrow">Execution trace</p>
            <h3>{activeTrace.runId}</h3>
          </div>
          <span className={`run-status ${activeTrace.status}`}>{activeTrace.status}</span>
        </div>

        <div className="trace-summary">
          <div><span>Duration</span><strong>{(activeTrace.durationMs / 1000).toFixed(2)}s</strong></div>
          <div><span>Tokens</span><strong>{activeTrace.tokens.toLocaleString()}</strong></div>
          <div><span>Catalog</span><strong>{getCatalog(activeTrace.catalogId).name}</strong></div>
        </div>

        <div className="trace-flow">
          {activeTrace.stages.map((stage, index) => (
            <div className="trace-stage" key={stage.id}>
              <div className="stage-rail">
                <span className={stage.status}>{stage.status === "complete" ? "✓" : index + 1}</span>
                {index < activeTrace.stages.length - 1 && <i />}
              </div>
              <div>
                <strong>{stage.label}</strong>
                <p>{stage.detail}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="boundary-card">
          <span className="boundary-icon">◎</span>
          <div>
            <strong>Isolation boundary held</strong>
            <p>Child context and tool events stay in the run trace, outside the chat history.</p>
          </div>
        </div>

        <div className="contract-card">
          <div className="panel-heading"><span>Adapter contract</span><span className="version">v1</span></div>
          <code>POST /chat</code>
          <p>prompt · catalogId · conversationId</p>
          <code>→ content · trace · messageId</code>
        </div>
      </aside>
    </main>
  );
}
