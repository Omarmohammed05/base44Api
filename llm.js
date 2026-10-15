const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "base44-default";
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1")
  .replace(/\/+$/, "");
const UPSTREAM_TIMEOUT_MS = 115000;

const MODELS = [{ id: DEFAULT_MODEL, created: 1700000000, owned_by: "base44" }];

function hasUpstream() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function providerName() {
  return hasUpstream() ? "openai-compatible" : "mock";
}

// Rough token estimation (~4 chars per token) when exact counts are unavailable.
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

// Convert messages[] into one clearly labeled prompt (system/user/assistant roles).
function buildPrompt(messages) {
  return (
    messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n") +
    "\n\nASSISTANT:"
  );
}

// Split final text into SSE chunks when real streaming isn't available.
function chunkText(text, size = 24) {
  const pieces = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces.length ? pieces : [""];
}

// ---- mock provider (default: no LLM provider key configured) ----
function mockChat(req) {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  let content;
  if (req.response_format && req.response_format.type === "json_object") {
    content = JSON.stringify({
      mock: true,
      note: "No LLM provider is configured; this is a deterministic mock response.",
      messages_received: req.messages.length,
      last_user_message: lastUser ? lastUser.content : null,
    });
  } else {
    content =
      "[mock response — no LLM provider configured] The proxy received " +
      `${req.messages.length} message(s) and converted them into this prompt:\n\n` +
      buildPrompt(req.messages).trim();
  }
  let finish_reason = "stop";
  if (req.max_tokens) {
    const maxChars = req.max_tokens * 4; // consistent with estimateTokens()
    if (content.length > maxChars) {
      content = content.slice(0, maxChars);
      finish_reason = "length";
    }
  }
  return {
    content,
    chunks: chunkText(content),
    model: req.model || DEFAULT_MODEL,
    finish_reason,
  };
}

// ---- OpenAI-compatible upstream (active when OPENAI_API_KEY is set) ----
async function openaiChat(req) {
  const payload = {
    model: req.model || DEFAULT_MODEL,
    messages: req.messages,
    stream: false,
  };
  if (req.temperature != null) payload.temperature = req.temperature;
  if (req.max_tokens != null) payload.max_tokens = req.max_tokens;
  if (req.response_format) payload.response_format = req.response_format;

  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    const err = new Error(`Upstream LLM provider returned ${r.status}: ${detail}`);
    err.statusCode = r.status === 400 ? 400 : 500;
    err.type =
      r.status === 400 ? "invalid_request_error" : "server_error";
    throw err;
  }
  const data = await r.json();
  const choice = (data.choices && data.choices[0]) || {};
  const content = (choice.message && choice.message.content) || "";
  return {
    content,
    chunks: chunkText(content),
    model: data.model || req.model || DEFAULT_MODEL,
    finish_reason: choice.finish_reason || "stop",
  };
}

async function openaiModels() {
  const r = await fetch(`${OPENAI_BASE}/models`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const err = new Error(`Upstream LLM provider returned ${r.status} for /models.`);
    err.statusCode = 500;
    err.type = "server_error";
    throw err;
  }
  const data = await r.json();
  return (data.data || []).map((m) => ({
    id: m.id,
    created: m.created || 0,
    owned_by: m.owned_by || "openai",
  }));
}

async function generateChat(req) {
  return hasUpstream() ? openaiChat(req) : mockChat(req);
}

async function listModels() {
  return hasUpstream() ? openaiModels() : MODELS;
}

module.exports = {
  DEFAULT_MODEL,
  MODELS,
  generateChat,
  listModels,
  estimateTokens,
  buildPrompt,
  providerName,
};
