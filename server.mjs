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

// ── Web search via DuckDuckGo ──
async function handleSearch(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const query = url.searchParams.get("q") || "";
  if (!query.trim()) { sendJson(res, 400, { error: "Missing query." }); return; }
  try {
    const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
    const data = await ddg.json();
    const results = [];
    if (data.AbstractText) results.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL || "" });
    if (data.Answer) results.push({ title: query, snippet: data.Answer, url: "" });
    (data.RelatedTopics || []).slice(0, 5).forEach(t => {
      if (t.Text) results.push({ title: t.Text.slice(0, 80), snippet: t.Text, url: t.FirstURL || "" });
    });
    (data.Results || []).slice(0, 5).forEach(r => {
      if (r.Text) results.push({ title: r.Text.slice(0, 80), snippet: r.Text, url: r.FirstURL || "" });
    });
    sendJson(res, 200, { results: results.slice(0, 8) });
  } catch (err) {
    sendJson(res, 503, { error: "Search failed." });
  }
}

// ── OpenRouter chat proxy ──
async function handleChat(req, res) {
  console.log("📥 Chat request received");
  let payload;
  try { payload = await readRequestJson(req); } catch { sendJson(res, 400, { error: "Invalid JSON." }); return; }
  if (!openrouterApiKey) { sendJson(res, 500, { error: "Server API key not configured." }); return; }
  const model = payload.model || "deepseek/deepseek-v4-flash:free";
  console.log(`🤖 Model: ${model}`);
  let response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openrouterApiKey}`, "HTTP-Referer": `http://localhost:${port}`, "X-Title": "Milo" },
      body: JSON.stringify({ model, messages: payload.messages || [], temperature: payload.temperature ?? 0.7, max_tokens: payload.max_tokens ?? 1400, stream: payload.stream ?? false })
    });
  } catch (err) { console.error("❌ Fetch error:", err.message); sendJson(res, 503, { error: "Could not connect." }); return; }
  if (payload.stream) {
    res.writeHead(response.status, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    const reader = response.body.getReader();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); } res.end(); }
    catch (err) { console.error("❌ Stream error:", err.message); res.end(); }
    return;
  }
  try {
    const data = await response.json();
    if (!response.ok) {
      const msg = typeof data.error === 'object' ? (data.error?.message || JSON.stringify(data.error)) : (data.error || "OpenRouter error");
      sendJson(res, response.status, { error: msg }); return;
    }
    sendJson(res, 200, { content: data.choices?.[0]?.message?.content || "" });
  } catch (err) { console.error("❌ Parse error:", err.message); sendJson(res, 503, { error: "Unexpected error." }); }
}

// ── Static files ──
async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(file);
  } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found"); }
}

const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);
  if (req.method === "GET" && req.url.startsWith("/api/search")) { await handleSearch(req, res); return; }
  if (req.method === "POST" && req.url === "/api/chat") { await handleChat(req, res); return; }
  if (req.method === "GET") { await serveStatic(req, res); return; }
  res.writeHead(405); res.end("Method not allowed");
});

server.listen(port, () => {
  console.log(`Milo running on port ${port}`);
  console.log(`API key configured: ${openrouterApiKey ? "YES" : "NO"}`);
});