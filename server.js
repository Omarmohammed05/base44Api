const express = require("express");
const path = require("path");
const crypto = require("crypto");
const {
  generateChat,
  listModels,
  estimateTokens,
  buildPrompt,
  providerName,
} = require("./llm");

const PORT = parseInt(process.env.PORT || "3000", 10);
const app = express();
app.disable("x-powered-by");

// Generous request size limit (spec: no artificial limits)
app.use(express.json({ limit: "25mb" }));

// ---------- helpers ----------
function apiError(message, type = "invalid_request_error", code = null) {
  return { error: { message, type, code, param: null } };
}

function sendError(res, status, message, type, code) {
  res.status(status).json(apiError(message, type, code));
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------- status page + health ----------
app.get("/health", (req, res) =>
  res.json({ status: "ok", provider: providerName() })
);
app.use(express.static(path.join(__dirname, "public")));

// ---------- CORS for the OpenAI-compatible surface ----------
app.use("/v1", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- auth ----------
app.use("/v1", (req, res, next) => {
  const expected = process.env.PROXY_API_KEY;
  if (!expected) {
    return sendError(
      res,
      500,
      "Proxy is not configured: PROXY_API_KEY is not set.",
      "server_error",
      "proxy_not_configured"
    );
  }
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !safeEqual(token, expected)) {
    return sendError(
      res,
      401,
      "Invalid API key provided.",
      "invalid_request_error",
      "invalid_api_key"
    );
  }
  next();
});

// ---------- GET /v1/models ----------
app.get("/v1/models", async (req, res, next) => {
  try {
    const models = await listModels();
    res.json({
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: m.created,
        owned_by: m.owned_by,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- POST /v1/chat/completions ----------
app.post("/v1/chat/completions", async (req, res, next) => {
  try {
    const body = req.body || {};

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendError(res, 400, "'messages' must be a non-empty array.");
    }
    for (const m of body.messages) {
      if (
        !m ||
        typeof m !== "object" ||
        !["system", "user", "assistant"].includes(m.role) ||
        typeof m.content !== "string"
      ) {
        return sendError(
          res,
          400,
          "Each message needs a 'role' of system|user|assistant and a string 'content'."
        );
      }
    }
    if (body.temperature != null && typeof body.temperature !== "number") {
      return sendError(res, 400, "'temperature' must be a number.");
    }
    if (
      body.max_tokens != null &&
      (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)
    ) {
      return sendError(res, 400, "'max_tokens' must be a positive integer.");
    }
    if (body.stream != null && typeof body.stream !== "boolean") {
      return sendError(res, 400, "'stream' must be a boolean.");
    }
    if (
      body.response_format != null &&
      (typeof body.response_format !== "object" ||
        !["text", "json_object"].includes(body.response_format.type))
    ) {
      return sendError(
        res,
        400,
        "'response_format.type' must be 'text' or 'json_object'."
      );
    }

    const result = await generateChat({
      model:
        typeof body.model === "string" && body.model ? body.model : undefined,
      messages: body.messages,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      response_format: body.response_format,
    });

    const id = newId("chatcmpl");
    const created = Math.floor(Date.now() / 1000);
    const model = result.model;
    const finish_reason = result.finish_reason;
    const prompt_tokens = estimateTokens(buildPrompt(body.messages));

    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      for (const piece of result.chunks) {
        if (res.destroyed) return; // client disconnected
        res.write(chunk({ content: piece }, null));
      }
      if (res.destroyed) return;
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const completion_tokens = estimateTokens(result.content);
    res.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.content },
          finish_reason,
        },
      ],
      usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- fallbacks ----------
app.use((req, res) =>
  sendError(res, 404, `Unknown request URL: ${req.method} ${req.path}.`)
);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return sendError(res, 400, `Invalid JSON body: ${err.message}`);
  }
  const status =
    err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const type =
    err && err.type ? err.type : status === 500 ? "server_error" : "invalid_request_error";
  if (status >= 500) console.error(err);
  sendError(res, status, (err && err.message) || "Internal error.", type, err && err.code);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`openai-proxy listening on :${PORT} (provider: ${providerName()})`);
});

// Spec: 120s timeout
server.requestTimeout = 120000;
server.headersTimeout = 125000;
