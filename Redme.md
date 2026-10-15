Build a minimal OpenAI-compatible API proxy for personal use, powered by the built-in LLM integration in my Base44 subscription. Do NOT ask me for any external API key.

ENDPOINTS (public HTTP backend functions, CORS enabled)

1. POST /v1/chat/completions
   - Accept the OpenAI format: model, messages[], temperature, max_tokens, stream, response_format.
   - Convert messages[] into one prompt with clearly labeled system/user/assistant roles, call the built-in LLM integration, and return the exact OpenAI response shape (id, object: "chat.completion", created, model, choices[{index, message{role, content}, finish_reason}], usage{prompt_tokens, completion_tokens, total_tokens}). Estimate tokens if exact counts aren't available.
   - If stream=true, return SSE in OpenAI chunk format ending with "data: [DONE]". If real streaming isn't supported, simulate it by chunking the final text.
   - Support conversation history (full messages array every request).

2. GET /v1/models
   - Return the models available in my subscription in OpenAI list format.
   - If the integration lets me choose a model, map the "model" field from the request to the matching underlying model. Otherwise use the default model and ignore the field.

AUTH
- One secret API key stored as an environment variable/secret called PROXY_API_KEY.
- Require header Authorization: Bearer <PROXY_API_KEY> on every request.
- Return OpenAI-style errors (401, 400, 500) as JSON.

NO LIMITS
- No rate limiting, no monthly caps, no usage entities, no admin UI. Keep it as simple as possible.
- Only set a 120s timeout and a generous request size limit.

DELIVERABLE
1. Show me the final Base URL (ending in /v1).
2. Tell me how to set PROXY_API_KEY and what value to use.
3. Give me a working curl example plus a Python OpenAI SDK snippet and a Cursor/n8n config example (base_url + api_key + model).
4. Test the endpoint yourself with a sample request and confirm it returns a valid response.
