import React, { useEffect, useMemo, useRef, useState } from "react";

function App() {
  const [state, setState] = useState("pa");
  const [district, setDistrict] = useState("");
  const [year, setYear] = useState("all");
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [meetings, setMeetings] = useState(0);
  const [filesDiscovered, setFilesDiscovered] = useState(0);
  const [filesDownloaded, setFilesDownloaded] = useState(0);
  const [failed, setFailed] = useState(0);
  const [logLines, setLogLines] = useState([]);
  const [files, setFiles] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [startedAt, setStartedAt] = useState(null);
  const [endedAt, setEndedAt] = useState(null);
  const [elapsed, setElapsed] = useState(null);
  const [outDir, setOutDir] = useState("");
  const [autoDownload, setAutoDownload] = useState(true);
  const [downloadDir, setDownloadDir] = useState(null);
  const [downloadDirName, setDownloadDirName] = useState("");
  const downloadQueueRef = useRef([]);
  const activeDownloadsRef = useRef(0);
  const maxConcurrentDownloads = 4;
  // const API_BASE = import.meta.env.VITE_API_BASE || "";

  const logRef = useRef(null);
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines, autoScroll]);

  const yearOptions = useMemo(() => {
    const now = new Date().getFullYear();
    const arr = ["all"];
    for (let y = now; y >= now - 25; y--) arr.push(String(y));
    return arr;
  }, []);

  function addLog(message) {
    setLogLines((prev) => [...prev, message]);
  }

  async function selectDownloadDirectory() {
    try {
      if (!window.showDirectoryPicker) {
        alert(
          "Your browser doesn't support the File System Access API. Files will download to your default Downloads folder instead."
        );
        return;
      }

      const dirHandle = await window.showDirectoryPicker({
        mode: "readwrite",
      });
      setDownloadDir(dirHandle);
      setDownloadDirName(dirHandle.name);
      addLog(`📁 Selected download directory: ${dirHandle.name}`);
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Error selecting directory:", err);
      }
    }
  }

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function processDownloadQueue(jobId) {
    while (
      downloadQueueRef.current.length > 0 &&
      activeDownloadsRef.current < maxConcurrentDownloads
    ) {
      const fileInfo = downloadQueueRef.current.shift();
      activeDownloadsRef.current++;

      downloadFileWithStructure(jobId, fileInfo)
        .then(() => {
          setFilesDownloaded((prev) => prev + 1);
        })
        .catch(() => {
          setFailed((prev) => prev + 1);
        })
        .finally(() => {
          activeDownloadsRef.current--;
          processDownloadQueue(jobId);
        });

      await sleep(100);
    }
  }

  async function downloadFileWithStructure(jobId, fileInfo, retries = 3) {
    const filename =
      fileInfo.filename || fileInfo.path?.split("/").pop() || "file";
    const downloadUrl = fileInfo.url;

    if (!downloadUrl) {
      console.error("No download URL provided");
      return;
    }

    const proxyUrl = `/api/proxy-download?${new URLSearchParams({
      url: downloadUrl,
      filename: filename,
      ...(fileInfo.cookieHeader ? { cookieHeader: fileInfo.cookieHeader } : {}),
    })}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (downloadDir && window.showDirectoryPicker) {
          const yearDir = await downloadDir.getDirectoryHandle(fileInfo.year, {
            create: true,
          });
          const meetingDir = await yearDir.getDirectoryHandle(
            fileInfo.meetingId,
            { create: true }
          );
          const fileHandle = await meetingDir.getFileHandle(filename, {
            create: true,
          });
          const writable = await fileHandle.createWritable();

          const response = await fetch(proxyUrl);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const blob = await response.blob();
          await writable.write(blob);
          await writable.close();
          return;
        } else {
          fallbackDownload(proxyUrl, filename);
          return;
        }
      } catch (err) {
        if (attempt === retries) {
          console.error(`Failed after ${retries} attempts:`, filename, err);
          addLog(`⚠️ Failed: ${filename}`);
          throw err;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await sleep(delay);
      }
    }
  }

  function fallbackDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function startCrawl(e) {
    e.preventDefault();

    if (autoDownload && !downloadDir && window.showDirectoryPicker) {
      addLog("⚠️ Please select a download folder first");
      await selectDownloadDirectory();
      return;
    }

    setSubmitting(true);
    setPhase("starting");
    setMeetings(0);
    setFilesDiscovered(0);
    setFilesDownloaded(0);
    setFailed(0);
    setLogLines([]);
    setFiles([]);
    setStartedAt(null);
    setEndedAt(null);
    setElapsed(null);

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state,
          district,
          year,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { jobId } = await res.json();
      setJobId(jobId);
      addLog(`🚀 Started job ${jobId} for ${state}/${district}/${year}`);
      connectSSE(jobId);
    } catch (e) {
      addLog(`❌ Failed to start: ${e.message}`);
      setSubmitting(false);
      setPhase("idle");
    }
  }

  function connectSSE(jobId) {
    const es = new EventSource(
      `/api/crawl/stream?jobId=${encodeURIComponent(jobId)}`
    );

    es.addEventListener("open", () => {
      addLog("🔌 Connected to job stream.");
    });

    es.addEventListener("error", () => {
      addLog("⚠️ Stream error/closed.");
      es.close();
      setSubmitting(false);
    });

    es.addEventListener("log", (evt) => {
      try {
        const { message } = JSON.parse(evt.data);
        addLog(message);
      } catch {}
    });

    es.addEventListener("progress", (evt) => {
      try {
        const p = JSON.parse(evt.data);
        setPhase(p.phase || "running");
        if (typeof p.meetings === "number") setMeetings(p.meetings);
        if (typeof p.filesDiscovered === "number")
          setFilesDiscovered(p.filesDiscovered);
        if (typeof p.filesDownloaded === "number")
          setFilesDownloaded(p.filesDownloaded);
        if (typeof p.failed === "number") setFailed(p.failed);
        if (p.startedAt) setStartedAt(p.startedAt);
      } catch {}
    });

    es.addEventListener("file", (evt) => {
      try {
        const f = JSON.parse(evt.data);
        setFiles((prev) => [f, ...prev].slice(0, 1000)); // keep last 1000

        if (autoDownload && f.url && f.year && f.meetingId) {
          downloadQueueRef.current.push(f);
          processDownloadQueue(jobId);
        }
      } catch {}
    });

    es.addEventListener("summary", (evt) => {
      try {
        const s = JSON.parse(evt.data);
        setEndedAt(s.endedAt || null);
        setElapsed(s.elapsed || null);
        setPhase("done");
        addLog("🎉 Finished.");
      } catch {}
      es.close();
      setSubmitting(false);
    });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        color: "#0f172a",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>BoardDocs Crawler</h1>
          <span
            style={{
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 8,
              background:
                phase === "done"
                  ? "#dcfce7"
                  : phase === "idle"
                  ? "#e2e8f0"
                  : "#dbeafe",
              color:
                phase === "done"
                  ? "#166534"
                  : phase === "idle"
                  ? "#334155"
                  : "#1e40af",
            }}
          >
            {phase}
          </span>
        </header>

        <form
          onSubmit={startCrawl}
          style={{
            background: "#fff",
            borderRadius: 16,
            boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
            padding: 16,
            display: "grid",
            gridTemplateRows: "1fr 1fr 70px 110px",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div>
            <label style={{ fontSize: 13, fontWeight: 600 }}>
              State Code
            </label>
            <input
              style={{
                marginTop: 6,
                width: "98%",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: "10px 12px",
              }}
              placeholder="e.g., pa, ca, tx"
              value={state}
              onChange={(e) => setState(e.target.value.trim().toLowerCase())}
              required
            />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600 }}>
              District Code
            </label>
            <input
              style={{
                marginTop: 6,
                width: "98%",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: "10px 12px",
              }}
              placeholder="e.g., lmor"
              value={district}
              onChange={(e) => setDistrict(e.target.value.trim().toLowerCase())}
              required
            />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Year</label>
            <select
              style={{
                marginTop: 6,
                width: "99%",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: "10px 12px",
              }}
              value={year}
              onChange={(e) => setYear(e.target.value)}
              required
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              style={{
                fontSize: 13,
                fontWeight: 600,
                display: "block",
                marginBottom: 6,
                color: "#334155",
              }}
            >
              Auto-download to Local Machine
            </label>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={autoDownload}
                onChange={(e) => setAutoDownload(e.target.checked)}
                style={{
                  width: 18,
                  height: 18,
                  cursor: "pointer",
                }}
              />
              <span style={{ fontSize: 14, color: "#334155" }}>
                Automatically download files to my computer
              </span>
            </label>

            <button
              type="button"
              onClick={selectDownloadDirectory}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #e2e8f0",
                background: downloadDirName ? "#dcfce7" : "#fff",
                color: downloadDirName ? "#166534" : "#334155",
                fontSize: 13,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              {downloadDirName
                ? `📁 ${downloadDirName}`
                : "📂 Select Download Folder"}
            </button>

            <small
              style={{
                color: "#64748b",
                fontSize: 12,
                display: "block",
                marginTop: 6,
              }}
            >
              {downloadDirName
                ? `Files will save to ${downloadDirName} with year/meeting folders`
                : "Select a folder to organize downloads by year/meeting"}
            </small>
          </div>

          <div style={{ display: "flex", alignItems: "end" }}>
            <button
              type="submit"
              disabled={submitting}
              style={{
                width: "100%",
                borderRadius: 12,
                padding: "10px 14px",
                fontWeight: 600,
                color: "#fff",
                background: submitting ? "#94a3b8" : "#2563eb",
                cursor: submitting ? "not-allowed" : "pointer",
                border: "none",
              }}
            >
              {submitting ? "Running…" : "Start Crawl"}
            </button>
          </div>
        </form>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <StatCard label="Meetings" value={meetings} />
          <StatCard label="Files Found" value={filesDiscovered} />
          <StatCard label="Downloaded" value={filesDownloaded} />
          <StatCard label="Failed" value={failed} />
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
              padding: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <h2 style={{ fontWeight: 600 }}>Live Log</h2>
              <label style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Auto-scroll
              </label>
            </div>
            <div
              ref={logRef}
              style={{
                height: 290,
                overflow: "auto",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                background: "#f8fafc",
                padding: 12,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            >
              {logLines.length === 0 ? (
                <div style={{ color: "#94a3b8" }}>No logs yet…</div>
              ) : (
                logLines.map((ln, i) => <div key={i}>{ln}</div>)
              )}
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
              padding: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <h2 style={{ fontWeight: 600 }}>Recent Files</h2>
              <small style={{ color: "#64748b" }}>showing last 1000</small>
            </div>
            <div style={{ height: 290, overflow: "auto" }}>
              <table
                style={{
                  width: "100%",
                  fontSize: 14,
                  borderCollapse: "collapse",
                }}
              >
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 8px" }}>
                      Name
                    </th>
                    <th style={{ textAlign: "left", padding: "8px 8px" }}>
                      Year
                    </th>
                    <th style={{ textAlign: "left", padding: "8px 8px" }}>
                      Meeting
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {files.length === 0 ? (
                    <tr>
                      <td
                        colSpan={3}
                        style={{
                          padding: 24,
                          textAlign: "center",
                          color: "#94a3b8",
                        }}
                      >
                        No files yet…
                      </td>
                    </tr>
                  ) : (
                    files.map((f, idx) => (
                      <tr key={idx} style={{ borderTop: "1px solid #e2e8f0" }}>
                        <td
                          style={{ padding: "8px 8px", maxWidth: 320 }}
                          title={f.url}
                        >
                          {f.filename ||
                            (f.path || f.url || "").split("/").pop()}
                        </td>
                        <td style={{ padding: "8px 8px" }}>{f.year || "—"}</td>
                        <td
                          style={{
                            padding: "8px 8px",
                            fontFamily: "ui-monospace, Menlo, monospace",
                            fontSize: 12,
                          }}
                        >
                          {f.meetingId || "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section
          style={{
            background: "#fff",
            borderRadius: 16,
            boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
            padding: 16,
          }}
        >
          <h2 style={{ fontWeight: 600, marginBottom: 8 }}>Run Summary</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
              fontSize: 14,
              color: "#334155",
            }}
          >
            <div>
              Job ID:{" "}
              <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>
                {jobId || "—"}
              </span>
            </div>
            <div>Started: {startedAt || "—"}</div>
            <div>Ended: {endedAt || "—"}</div>
            <div style={{ gridColumn: "1 / -1" }}>
              Elapsed: {elapsed || "—"}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 16,
        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
        padding: 16,
      }}
    >
      <div style={{ fontSize: 13, color: "#64748b" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default App;
