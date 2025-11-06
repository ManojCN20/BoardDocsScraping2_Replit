// server/server.js
import express from "express";
import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { startBoardDocsCrawl } from "./crawler.js";
// import cors from "cors"; // uncomment if you need cross-origin access

const app = express();
app.use(express.json());
// app.use(cors({ origin: "*" })); // optional, only if calling from a different origin

const jobs = new Map(); // jobId -> { emitter }

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post("/api/crawl", async (req, res) => {
  const { state, district, years } = req.body || {};
  if (!state) return res.status(400).json({ error: "state required" });
  if (!district) return res.status(400).json({ error: "district required" });

  const jobId = Math.random().toString(36).slice(2);
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter });

  // respond immediately with job id
  res.json({ jobId });

  // fire and forget
  startBoardDocsCrawl({
    state,
    district,
    years: years || ["all"],
    onLog: (message) => emitter.emit("log", { message }),
    onProgress: (p) => emitter.emit("progress", p),
    onFile: (f) => emitter.emit("file", f),
    onSummary: (s) => emitter.emit("summary", s),
  }).catch((err) => {
    emitter.emit("log", { message: `❌ Fatal: ${err.message}` });
    emitter.emit("summary", { error: err.message });
  });
});

app.get("/api/crawl/stream", (req, res) => {
  const { jobId } = req.query;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).end();

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // If you enabled CORS above and you serve UI elsewhere, you can also set:
  // res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const { emitter } = job;
  const onLog = (d) => send("log", d);
  const onProgress = (d) => send("progress", d);
  const onFile = (d) => send("file", d);
  const onSummary = (d) => {
    send("summary", d);
    cleanup();
  };

  function cleanup() {
    emitter.off("log", onLog);
    emitter.off("progress", onProgress);
    emitter.off("file", onFile);
    emitter.off("summary", onSummary);
    res.end();
    jobs.delete(jobId);
  }

  req.on("close", cleanup);

  emitter.on("log", onLog);
  emitter.on("progress", onProgress);
  emitter.on("file", onFile);
  emitter.on("summary", onSummary);

  send("log", { message: "🔌 Stream connected" });
});

// Proxy file downloads (no disk storage, just streaming)
app.get("/api/proxy-download", async (req, res) => {
  const { url, cookieHeader, filename } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: "URL required" });
  }

  try {
    const { request: undiciRequest } = await import('undici');
    
    const headers = {
      Accept: "*/*",
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const { statusCode, body, headers: responseHeaders } = await undiciRequest(url, { 
      headers,
    });
    
    if (statusCode !== 200) {
      body.resume();
      return res.status(statusCode).json({ error: `HTTP ${statusCode}` });
    }

    const safeName = (filename || 'file')
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_')
      .substring(0, 200);
    
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', responseHeaders['content-type'] || 'application/octet-stream');
    if (responseHeaders['content-length']) {
      res.setHeader('Content-Length', responseHeaders['content-length']);
    }
    
    body.pipe(res);
    
    body.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// -------------------- Serve built frontend (optional) --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Only serve the frontend if SERVE_WEB=1 and dist exists
const SERVE_WEB = process.env.SERVE_WEB === "1";
const distPath = path.join(__dirname, "../web/dist");
const distExists = (() => {
  try {
    return fs.existsSync(path.join(distPath, "index.html"));
  } catch {
    return false;
  }
})();

if (SERVE_WEB && distExists) {
  // Serve static assets first
  app.use(express.static(distPath));

  // Express 5 safe SPA fallback: serve index.html for any non-API GET
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  // API-only mode landing
  app.get("/", (req, res) => {
    res
      .type("text/plain")
      .send("API is running. Frontend not served by this instance.");
  });
  // Other non-API routes fall through to 404
}

// ------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API listening on :${PORT}`);
  if (SERVE_WEB) {
    console.log(
      distExists
        ? `✅ Serving frontend from ${distPath}`
        : "⚠️ SERVE_WEB=1 but ../web/dist/index.html not found. Not serving UI."
    );
  } else {
    console.log("ℹ️ Frontend serving disabled (SERVE_WEB != 1).");
  }
});
