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
// Generate unique filename with document ID: Name__DOCID.ext
function uniqueFilename(url) {
  const base = fileNameFromUrl(url);
  const ext = path.extname(base);
  const name = path.basename(base, ext);
  const docId = docIdFromUrl(url);
  return docId ? `${name}__${docId}${ext}` : base;
}
// District/<year>/Name__DOCID.ext
function uniqueOutPathScoped(u, district, year) {
  const unique = uniqueFilename(u);
  return path.join(
    String(district || "unknown"),
    String(year || "unknown"),
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
async function collectMeetings(browser, START_URL, YEARS_ARG) {
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

    // Extract year from section header text
    const headerText = await header.textContent().catch(() => "");
    const yearMatch = headerText.match(/\b(20\d{2})\b/);
    const sectionYear = yearMatch ? yearMatch[1] : null;

    // Skip this section if we're filtering by specific years and this section doesn't match
    if (
      !YEARS_ARG.includes("all") &&
      sectionYear &&
      !YEARS_ARG.includes(sectionYear)
    ) {
      continue;
    }

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
          text: (a.textContent || "").trim(),
        }))
      )
      .catch(() => []);

    // Assign the section year to all meetings in this section
    const meetingsWithYear = meetings
      .filter((m) => m.id)
      .map((m) => ({ ...m, year: sectionYear }));

    all.push(...meetingsWithYear);
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
      sleep(5000),
    ]);
  } catch (e) {
    // Priming failed, continue anyway
  }
}

/* ---------- Exported entry ---------- */
export async function startBoardDocsCrawl({
  state = "pa",
  districts = [],
  years = ["all"],
  headless = true,
  dlConcurrency = 16,
  onLog = () => {},
  onProgress = () => {},
  onFile = () => {},
  onSummary = () => {},
}) {
  const RUN_START = Date.now();
  
  if (!districts || districts.length === 0) {
    throw new Error("At least one district is required");
  }

  onLog(`📡 Files will download directly to your browser`);
  onLog(`🎯 Processing ${districts.length} district(s): ${districts.join(", ")}`);

  let totalFilesAllDistricts = 0;

  try {
    const yearStr = years.includes("all") ? "all years" : years.join(", ");

    function findChromiumPath() {
      const macChromiumPaths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/opt/homebrew/bin/chromium",
      ];

      // 1️⃣ Use CHROMIUM_PATH env var if valid
      if (
        process.env.CHROMIUM_PATH &&
        fs.existsSync(process.env.CHROMIUM_PATH)
      ) {
        return process.env.CHROMIUM_PATH;
      }

      // 2️⃣ Try common macOS/Linux Chromium paths
      for (const path of macChromiumPaths) {
        if (fs.existsSync(path)) return path;
      }

      // 3️⃣ Try Playwright's bundled Chromium
      try {
        const pw = require("playwright-core");
        const browserPath = pw.chromium.executablePath();
        if (fs.existsSync(browserPath)) return browserPath;
      } catch (e) {
        // ignore
      }

      // 4️⃣ Fallback (old Nix path, for compatibility)
      const nixPath =
        "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
      if (fs.existsSync(nixPath)) return nixPath;

      throw new Error(
        "❌ Chromium executable not found. Please install Chrome or run `npx playwright install chromium`."
      );
    }

    const executablePath = findChromiumPath();

    // Loop through each district
    for (let districtIndex = 0; districtIndex < districts.length; districtIndex++) {
      const district = districts[districtIndex];
      const START_URL = `https://go.boarddocs.com/${state}/${district}/Board.nsf/Public`;
      
      onLog(`\n${"=".repeat(60)}`);
      onLog(`📍 District ${districtIndex + 1}/${districts.length}: ${district}`);
      onLog(`🚀 Opening: ${START_URL}  (years: ${yearStr})`);
      onLog(`${"=".repeat(60)}`);

      // ✅ Launch Chromium with fallback logic
      const browser = await chromium.launch({
        headless,
        executablePath,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      const { page, context, meetings, mframe } = await collectMeetings(
        browser,
        START_URL,
        years
      );
      onLog(`🗓️ Meetings discovered: ${meetings.length}`);
      onProgress({
        phase: "discovery",
        district,
        districtIndex: districtIndex + 1,
        totalDistricts: districts.length,
        meetings: meetings.length,
        startedAt: fmtTs(RUN_START),
      });

      if (!meetings.length) {
        onLog(`⚠️ No meetings found for ${district}`);
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        continue;
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
      const allItems = []; // { url, year, meetingId, district }

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
              allItems.push({ url: u, year: m.year, meetingId: m.id, district })
            );
            onProgress({
              phase: "parsing",
              district,
              districtIndex: districtIndex + 1,
              totalDistricts: districts.length,
              filesDiscovered: allItems.length,
            });
          } catch {}
        })
      );
      await agendaQueue.onIdle();

      // ---- Step 2: Send all files to frontend (no deduplication) ----
      const totalCount = allItems.length;

      onLog(`🔎 Files discovered: ${totalCount} (all files, including duplicates)`);
      onLog(`📡 Sending file list to browser for direct download...`);

      let sent = 0;
      for (const { url, year: y, meetingId, district: d } of allItems) {
        const filename = uniqueFilename(url);
        onFile({
          url,
          year: y,
          meetingId,
          filename,
          district: d,
          cookieHeader,
        });
        sent++;
        onProgress({
          phase: "sending",
          district: d,
          districtIndex: districtIndex + 1,
          totalDistricts: districts.length,
          filesDiscovered: allItems.length,
          filesSent: sent,
        });
      }

      totalFilesAllDistricts += allItems.length;
      onLog(`✅ Completed ${district}: ${allItems.length} files sent`);
    }

    const RUN_END = Date.now();
    onLog(`\n${"=".repeat(60)}`);
    onLog(`✅ All districts complete!`);
    onLog(`${"=".repeat(60)}`);
    onSummary({
      endedAt: fmtTs(RUN_END),
      elapsed: fmtDur(RUN_END - RUN_START),
      totalFiles: totalFilesAllDistricts,
      districtsProcessed: districts.length,
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
