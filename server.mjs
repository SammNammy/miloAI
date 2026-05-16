import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);
const openrouterApiKey = process.env.OPENROUTER_API_KEY || "";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function handleChat(req, res) {
  console.log("📥 Chat request received");
  let payload;
  try {
    payload = await readRequestJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON." });
    return;
  }

  if (!openrouterApiKey) {
    sendJson(res, 500, { error: "Server API key not configured." });
    return;
  }

  // Attempt the OpenRouter API call – but DO NOT send response headers yet
  let response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openrouterApiKey}`,
        "HTTP-Referer": `http://localhost:${port}`,
        "X-Title": "Milo"
      },
      body: JSON.stringify({
        model: payload.model || "openai/gpt-oss-120b:free",
        messages: payload.messages || [],
        temperature: payload.temperature ?? 0.7,
        max_tokens: payload.max_tokens ?? 1400,
        stream: payload.stream ?? false
      })
    });
  } catch (err) {
    console.error("❌ OpenRouter fetch error:", err.message);
    sendJson(res, 503, { error: "Could not connect to OpenRouter." });
    return;
  }

  // Handle streaming response
  if (payload.stream) {
    // Stream the response – once headers are sent, we must NOT use sendJson
    res.writeHead(response.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      console.error("❌ Streaming error:", err.message);
      // Response already started – just end it, the client will see an incomplete stream
      res.end();
    }
    return;
  }

  // Handle normal (non‑streaming) response
  try {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "OpenRouter error");
    sendJson(res, 200, { content: data.choices?.[0]?.message?.content || "" });
  } catch (err) {
    console.error("❌ OpenRouter error:", err.message);
    sendJson(res, 503, { error: err.message });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);

  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }
  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(port, () => {
  console.log(`Milo running on port ${port}`);
  console.log(`API key configured: ${openrouterApiKey ? "YES" : "NO"}`);
});