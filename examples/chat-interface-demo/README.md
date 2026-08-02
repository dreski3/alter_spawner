# Naut Relay chat demo

A standalone chat interface for exercising alter-spawner catalogs. It runs with
a browser-side demo adapter by default and can point at any compatible runtime
without changing the UI.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Connect an alter runtime

Copy `.env.example` to `.env.local` and set the base URL:

```bash
NEXT_PUBLIC_ALTER_API_URL=http://localhost:8788
```

The adapter sends:

```http
POST /chat
content-type: application/json

{
  "prompt": "Review this plan",
  "catalogId": "code-review",
  "conversationId": "demo-conversation"
}
```

The runtime responds with:

```json
{
  "messageId": "msg_123",
  "content": "The alter's validated final response",
  "trace": {
    "runId": "run_123",
    "catalogId": "code-review",
    "status": "complete",
    "durationMs": 1840,
    "tokens": 1284,
    "stages": [
      {
        "id": "principal",
        "label": "Principal",
        "status": "complete",
        "detail": "Prompt accepted"
      }
    ]
  }
}
```

The transport boundary lives in `app/lib/chat-adapter.ts`. Catalog presentation
metadata lives in `app/lib/catalogs.ts`, so adding or removing catalogs does not
change the conversation component. A future alter-spawner bridge only needs to
translate this request into `spawnAlter` or `runAlterGraph`, then map its result
and trace back to the response above.

## Checks

```bash
npm run build
npm test
```
