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

// Proxy endpoint for OpenRouter
async function handleChat(req, res) {
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

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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

    // For streaming, pipe the response directly
    if (payload.stream) {
      res.writeHead(response.status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      const reader = response.body.getReader();
      const writer = new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        }
      });
      await reader.pipeTo(writer);
      return;
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "OpenRouter error");
    sendJson(res, 200, { content: data.choices?.[0]?.message?.content || "" });
  } catch (err) {
    sendJson(res, 503, { error: err.message });
  }
}

// Serve static files
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
});