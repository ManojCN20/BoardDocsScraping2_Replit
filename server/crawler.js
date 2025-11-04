// server/crawler.js
import { chromium } from "playwright";
import fs from "fs-extra";
import path from "path";
import PQueue from "p-queue";
import * as cheerio from "cheerio";
import { setGlobalDispatcher, Agent, request as undiciRequest } from "undici";
import os from "os";
import url from "url";

/** Expand "~", make absolute, normalize separators */
function resolveOutDir(inputDir, district) {
  let dir = inputDir && String(inputDir).trim();
  if (!dir) dir = `downloads_${district}`;

  // ~ expansion
  if (dir.startsWith("~")) dir = path.join(os.homedir(), dir.slice(1));

  // make absolute
  if (!path.isAbsolute(dir)) dir = path.resolve(process.cwd(), dir);

  // normalize for platform
  return path.normalize(dir);
}

/** Basic safety: ensure we can create/write here */
async function ensureWritable(dir) {
  await fs.ensureDir(dir);
  // try making a tiny temp file
  const probe = path.join(dir, `.write_test_${Date.now()}.tmp`);
  await fs.writeFile(probe, "ok");
  await fs.remove(probe);
}

/* ---------- Keep-Alive for max throughput ---------- */
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 60_000,
    keepAliveMaxSockets: 256,
  })
);

/* ---------- Utils ---------- */
const fmtTs = (ms) =>
  new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h ? `${h}h` : null, m ? `${m}m` : null, `${sec}s`]
    .filter(Boolean)
    .join(" ");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gotoWithRetries(page, url, attempts = 3, timeout = 45000) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      return;
    } catch (e) {
      last = e;
      await sleep(300 * i);
    }
  }
  throw last;
}
async function findFrameWith(page, selector, timeout = 15000, poll = 200) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const f of page.frames()) {
      try {
        if (await f.$(selector)) return f;
      } catch {}
    }
    await sleep(poll);
  }
  return null;
}
const sanitize = (s) => (s || "file").replace(/[\\/:*?"<>|]+/g, "_").trim();
const fileNameFromUrl = (u) => {
  try {
    const url = new URL(u);
    return sanitize(decodeURIComponent(path.basename(url.pathname) || "file"));
  } catch {
    return "file";
  }
};
const joinURL = (base, href) => {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
};

/* ---------- Cookie header builder ---------- */
function cookieHeaderFromStorageState(storageState) {
  const cookies = (storageState.cookies || []).filter((c) =>
    (c.domain || "").includes("go.boarddocs.com")
  );
  return cookies.length
    ? cookies.map((c) => `${c.name}=${c.value}`).join("; ")
    : "";
}

/* ---------- File-naming helpers (unique!) ---------- */
function docIdFromUrl(u) {
  try {
    const m = new URL(u).pathname.match(/\/files\/([^/]+)\/\$file\//i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
// downloads/<year>/<meetingId>/Name__DOCID.ext
function uniqueOutPathScoped(u, baseDir, year, meetingId) {
  const base = fileNameFromUrl(u);
  const ext = path.extname(base);
  const name = path.basename(base, ext);
  const docId = docIdFromUrl(u);
  const unique = docId ? `${name}__${docId}${ext}` : base;
  return path.join(
    baseDir,
    String(year || "unknown"),
    String(meetingId || "unknown"),
    unique
  );
}

/* ---------- HTML parsers ---------- */
function extractFileLinksFromAgendaHTML(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = new Set();

  $('a[href*="/files/"][href*="$file/"]').each((_, a) => {
    const href = $(a).attr("href");
    if (href) out.add(joinURL(baseUrl, href));
  });
  $("a.public-file").each((_, a) => {
    const href = $(a).attr("href");
    if (href) out.add(joinURL(baseUrl, href));
  });
  $("[data-url]").each((_, el) => {
    const u = $(el).attr("data-url");
    if (u && /\.(pdf|docx?|xlsx?|pptx?|csv|rtf|txt)(?:$|\?)/i.test(u))
      out.add(joinURL(baseUrl, u));
  });
  $('[id^="attachment-public-"]')
    .find("a[href]")
    .each((_, a) => {
      const href = $(a).attr("href");
      if (href) out.add(joinURL(baseUrl, href));
    });

  return Array.from(out);
}

/* ---------- Discovery (UI once) ---------- */
async function collectMeetings(browser, START_URL, YEAR_ARG) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await gotoWithRetries(page, START_URL);

  const enterBtn = page.getByText("Enter Public Site");
  if (await enterBtn.count().catch(() => 0)) {
    await enterBtn.click().catch(() => {});
    await sleep(200);
  }

  await page
    .locator('a#ui-id-3, #tab-meetings, a:has-text("Meetings")')
    .first()
    .click({ timeout: 10000 })
    .catch(() => {});
  await sleep(200);

  const mframe =
    (await findFrameWith(page, "#meeting-accordion", 20000)) ||
    (await findFrameWith(page, "a.icon.prevnext.meeting, a.meeting", 20000)) ||
    page.mainFrame();

  const headers = mframe.locator("section.ui-accordion-header");
  const count = await headers.count();
  const all = [];

  for (let i = 0; i < count; i++) {
    const header = headers.nth(i);
    const ariaControls = await header
      .getAttribute("aria-controls")
      .catch(() => null);

    await header.click({ timeout: 2000 }).catch(() => {});
    await sleep(100);
    const expanded = await header
      .getAttribute("aria-expanded")
      .catch(() => null);
    if (expanded === "false") {
      await header.click({ timeout: 2000 }).catch(() => {});
      await sleep(100);
    }

    const containerSel = ariaControls ? `#${ariaControls}` : ".wrap-year";
    const container = mframe.locator(containerSel);
    await container
      .locator("a.icon.prevnext.meeting, a.meeting")
      .first()
      .waitFor({ timeout: 4000 })
      .catch(() => {});

    const meetings = await container
      .locator("a.icon.prevnext.meeting, a.meeting")
      .evaluateAll((as) =>
        as.map((a) => ({
          id: a.getAttribute("id"),
          year: a.getAttribute("year"),
          text: (a.textContent || "").trim(),
        }))
      )
      .catch(() => []);

    const filtered = meetings.filter(
      (m) => m.id && (YEAR_ARG === "all" || m.year === YEAR_ARG)
    );
    all.push(...filtered);
  }

  const seen = new Set(),
    dedup = [];
  for (const m of all) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      dedup.push(m);
    }
  }

  return { page, context, meetings: dedup, mframe };
}

/* ---------- Prime once (UI), then close browser ---------- */
async function primeSessionAgenda(page, mframe, meetingId) {
  try {
    const a = await mframe.$(`a#${meetingId}`);
    if (!a) return;
    await Promise.race([
      (async () => {
        await a.scrollIntoViewIfNeeded().catch(() => {});
        await a.click({ timeout: 2000 }).catch(() => {});
        await page
          .locator('a#ui-id-4, #tab-agenda, a:has-text("Agenda")')
          .first()
          .click({ timeout: 2000 })
          .catch(() => {});
        await sleep(250);
      })(),
      sleep(5000)
    ]);
  } catch (e) {
    // Priming failed, continue anyway
  }
}

/* ---------- Exported entry ---------- */
export async function startBoardDocsCrawl({
  state = "pa",
  district,
  year = "all",
  outDir = `downloads_${district}`,
  headless = true,
  dlConcurrency = 16,
  onLog = () => {},
  onProgress = () => {},
  onFile = () => {},
  onSummary = () => {},
}) {
  const RUN_START = Date.now();
  const START_URL = `https://go.boarddocs.com/${state}/${district}/Board.nsf/Public`;
  
  onLog(`📡 Files will download directly to your browser`);

  try {
    onLog(`🚀 Opening: ${START_URL}  (year: ${year})`);
    const browser = await chromium.launch({
      headless,
      executablePath: process.env.CHROMIUM_PATH || '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const { page, context, meetings, mframe } = await collectMeetings(
      browser,
      START_URL,
      year
    );
    onLog(`🗓️ Meetings discovered: ${meetings.length}`);
    onProgress({
      phase: "discovery",
      meetings: meetings.length,
      startedAt: fmtTs(RUN_START),
    });

    if (!meetings.length) {
      const RUN_END = Date.now();
      onSummary({
        endedAt: fmtTs(RUN_END),
        elapsed: fmtDur(RUN_END - RUN_START),
        filesDownloaded: 0,
        failed: 0,
      });
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      return;
    }

    onLog(`🔄 Priming session with first meeting...`);
    await primeSessionAgenda(page, mframe, meetings[0].id);
    onLog(`✅ Session primed`);

    onLog(`📋 Saving session state...`);
    const storageState = await context.storageState();
    onLog(`🔒 Closing browser...`);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    onLog(`✅ Browser closed`);

    const cookieHeader = cookieHeaderFromStorageState(storageState);

    // ---- Step 1: Fetch Agenda HTMLs ----
    const agendaQueue = new PQueue({ concurrency: 32 });
    const allItems = []; // { url, year, meetingId }

    await agendaQueue.addAll(
      meetings.map((m) => async () => {
        const url = `https://go.boarddocs.com/${state}/${district}/Board.nsf/Download-AgendaDetailed?open&id=${encodeURIComponent(
          m.id
        )}&${Math.random()}`;
        try {
          const { statusCode, body } = await undiciRequest(url, {
            headers: {
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
              Accept: "text/html, */*",
            },
          });
          if (statusCode !== 200) {
            body.resume();
            return;
          }
          const html = await body.text();
          const urls = extractFileLinksFromAgendaHTML(html, url);
          urls.forEach((u) =>
            allItems.push({ url: u, year: m.year, meetingId: m.id })
          );
          onProgress({
            phase: "parsing",
            filesDiscovered: allItems.length,
          });
        } catch {}
      })
    );
    await agendaQueue.onIdle();

    // ---- Step 2: Dedup and send files to frontend ----
    const byUrl = new Map();
    for (const it of allItems) if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    const finalItems = Array.from(byUrl.values());
    onLog(`🔎 Files discovered: ${finalItems.length}`);
    onLog(`📡 Sending file list to browser for direct download...`);

    let sent = 0;
    for (const { url, year: y, meetingId } of finalItems) {
      const filename = fileNameFromUrl(url);
      onFile({ 
        url, 
        year: y, 
        meetingId, 
        filename,
        cookieHeader 
      });
      sent++;
      onProgress({
        phase: "sending",
        filesDiscovered: finalItems.length,
        filesSent: sent,
      });
    }

    const RUN_END = Date.now();
    onSummary({
      endedAt: fmtTs(RUN_END),
      elapsed: fmtDur(RUN_END - RUN_START),
      totalFiles: finalItems.length,
    });
  } catch (e) {
    const RUN_END = Date.now();
    onLog(`❌ Fatal: ${e.message}`);
    onSummary({
      endedAt: fmtTs(RUN_END),
      elapsed: fmtDur(RUN_END - RUN_START),
      error: e.message,
    });
    throw e;
  }
}
