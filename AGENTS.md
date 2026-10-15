# AGENTS.md

## Overview
Minimal OpenAI-compatible API proxy: Node.js + Express, single service, no database.
Entry point `server.js` (HTTP surface, auth, OpenAI-shaped responses), LLM backends in `llm.js`,
landing page in `public/index.html`.

## Run (Base44 sandbox)
`docker compose -f docker-compose.base44.yml up -d`
- Runs from the cloned source via bind mount; installs dependencies on container start; `node --watch` hot-reloads edits to `server.js`/`llm.js`.
- Web entry: host port 3000. Health: `GET /health`.
- After changing `package.json` dependencies, restart the container so `npm install` re-runs.

## Secrets (delivered via /run/base44/app.env, never in the repo)
- `PROXY_API_KEY` (required at boot): bearer key clients must send. Without it every /v1 request returns 500 `proxy_not_configured`.
- `OPENAI_API_KEY` (optional): when set, chat completions and the models list are forwarded to an OpenAI-compatible provider (`OPENAI_BASE_URL`, default `https://api.openai.com/v1`).
- `BASE44_LLM_URL` (+ optional `BASE44_LLM_KEY`): when set, chat requests are forwarded to the published public `llm` function of a Base44-builder app (body `{messages:[{role,content}]}`, expects `{content:"..."}`) — highest priority.
- With none set, `llm.js` serves a deterministic, clearly-labeled mock so the whole API shape is testable without any credentials — the Base44 built-in LLM is not directly reachable from this standalone imported app, only via the builder-app route above.

## Verify
- `curl localhost:3000/health` → 200.
- `GET /v1/models` with `Authorization: Bearer $PROXY_API_KEY` → `{"object":"list",...}`; without → 401 JSON.
- `POST /v1/chat/completions` (JSON, Content-Type: application/json) → exact OpenAI chat.completion shape incl. usage; `stream:true` → SSE chunks ending with `data: [DONE]`.
- Invalid body → 400; unknown URL → 404; upstream failure → 500. All errors are OpenAI-style JSON.
