import React, { useEffect, useMemo, useRef, useState } from "react";

function App() {
  const [state, setState] = useState("");
  const [district, setDistrict] = useState("");
  const [selectedYears, setSelectedYears] = useState(["all"]);
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
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [downloadStartTime, setDownloadStartTime] = useState(null);
  const [downloadEndTime, setDownloadEndTime] = useState(null);
  const [finalDownloadTime, setFinalDownloadTime] = useState(null);
  const [finalAvgSpeed, setFinalAvgSpeed] = useState(null);
  const [totalBytesDownloaded, setTotalBytesDownloaded] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);
  const downloadQueueRef = useRef([]);
  const activeDownloadsRef = useRef(0);
  const maxConcurrentDownloads = 24;
  const totalFilesExpectedRef = useRef(0);
  const downloadStartTimeRef = useRef(null);
  const filesDownloadedRef = useRef(0);
  const totalBytesDownloadedRef = useRef(0);
  const eventSourceRef = useRef(null);
  const isFinishingRef = useRef(false);
  // const API_BASE = import.meta.env.VITE_API_BASE || "";

  const logRef = useRef(null);

  // Helper function to format time in hh:mm:ss format
  function formatTime(seconds) {
    if (!seconds || seconds <= 0) return "00:00:00";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // Calculate current download elapsed time
  const [currentDownloadTime, setCurrentDownloadTime] = useState("00:00:00");

  // Update download time every second while downloading
  useEffect(() => {
    if (downloadStartTimeRef.current && phase !== 'idle' && phase !== 'done') {
      const timer = setInterval(() => {
        const elapsed = (Date.now() - downloadStartTimeRef.current) / 1000;
        setCurrentDownloadTime(formatTime(elapsed));
      }, 1000);
      return () => clearInterval(timer);
    } else if (downloadEndTime && downloadStartTimeRef.current) {
      setCurrentDownloadTime(formatTime((downloadEndTime - downloadStartTimeRef.current) / 1000));
    }
  }, [downloadStartTime, downloadEndTime, phase]);

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

  function stopDownloads() {
    setIsCancelling(true);
    addLog("🛑 Stopping downloads...");
    
    // Store how many we're skipping
    const queuedCount = downloadQueueRef.current.length;
    const activeCount = activeDownloadsRef.current;
    
    // Clear download queue to prevent new downloads
    downloadQueueRef.current = [];
    
    // Close EventSource if it exists
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    
    // Wait for active downloads to finish before finalizing (with timeout safeguard)
    const startWait = Date.now();
    const maxWaitTime = 60000; // 60 seconds max wait
    
    const checkComplete = setInterval(() => {
      const elapsed = Date.now() - startWait;
      
      if (activeDownloadsRef.current === 0 || elapsed > maxWaitTime) {
        clearInterval(checkComplete);
        
        if (elapsed > maxWaitTime) {
          addLog(`⚠️ Forced cancellation after ${(elapsed / 1000).toFixed(1)}s (${activeDownloadsRef.current} downloads still active)`);
        }
        
        setPhase("cancelled");
        setSubmitting(false);
        isFinishingRef.current = false;
        addLog(`❌ Cancelled. Completed ${activeCount} in-flight downloads, skipped ${queuedCount} queued.`);
        
        // Store final download metrics
        if (downloadStartTimeRef.current) {
          const endTime = Date.now();
          setDownloadEndTime(endTime);
          const totalTime = (endTime - downloadStartTimeRef.current) / 1000;
          const megabytesDownloaded = totalBytesDownloadedRef.current / (1024 * 1024);
          setFinalDownloadTime(totalTime);
          if (totalTime > 0) {
            setFinalAvgSpeed(megabytesDownloaded / totalTime);
          }
        }
      }
    }, 200);
  }

  function handleYearToggle(yearValue) {
    setSelectedYears((prev) => {
      if (yearValue === "all") {
        return prev.includes("all") ? [] : ["all"];
      } else {
        const newSelection = prev.filter((y) => y !== "all");
        if (newSelection.includes(yearValue)) {
          return newSelection.filter((y) => y !== yearValue);
        } else {
          return [...newSelection, yearValue];
        }
      }
    });
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
      activeDownloadsRef.current < maxConcurrentDownloads &&
      !isCancelling
    ) {
      const fileInfo = downloadQueueRef.current.shift();
      activeDownloadsRef.current++;

      downloadFileWithStructure(jobId, fileInfo)
        .then((bytesDownloaded) => {
          // Only count if file was actually downloaded (not skipped)
          if (bytesDownloaded !== -1) {
            setFilesDownloaded((prev) => {
              const newCount = prev + 1;
              filesDownloadedRef.current = newCount; // Keep ref in sync
              return newCount;
            });
          }
          
          // Track bytes and calculate speed in MB/s (skip if file was skipped or fallback)
          if (bytesDownloaded && bytesDownloaded > 0) {
            setTotalBytesDownloaded((prev) => {
              const newTotal = prev + bytesDownloaded;
              totalBytesDownloadedRef.current = newTotal;
              
              // Update download speed in MB/s
              if (downloadStartTimeRef.current) {
                const elapsed = (Date.now() - downloadStartTimeRef.current) / 1000; // seconds
                const megabytes = newTotal / (1024 * 1024);
                const speed = megabytes / elapsed;
                setDownloadSpeed(speed);
              }
              return newTotal;
            });
          }
        })
        .catch(() => {
          setFailed((prev) => prev + 1);
        })
        .finally(() => {
          activeDownloadsRef.current--;
          processDownloadQueue(jobId);
        });

      await sleep(50);
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
          
          // Check if file already exists and has content
          let fileExists = false;
          try {
            const existingHandle = await meetingDir.getFileHandle(filename);
            const existingFile = await existingHandle.getFile();
            if (existingFile.size > 0) {
              fileExists = true;
              return -1; // Return -1 to indicate file was skipped (already exists)
            }
          } catch (e) {
            // File doesn't exist, continue with download
          }
          
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
          return blob.size;
        } else {
          fallbackDownload(proxyUrl, filename);
          return 0; // Can't track size for fallback downloads
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
    setDownloadSpeed(0);
    setDownloadStartTime(null);
    setDownloadEndTime(null);
    setFinalDownloadTime(null);
    setFinalAvgSpeed(null);
    setTotalBytesDownloaded(0);
    setCurrentDownloadTime("00:00:00");
    setIsCancelling(false);
    downloadQueueRef.current = [];
    activeDownloadsRef.current = 0;
    totalFilesExpectedRef.current = 0;
    downloadStartTimeRef.current = null;
    filesDownloadedRef.current = 0;
    totalBytesDownloadedRef.current = 0;
    isFinishingRef.current = false;

    if (selectedYears.length === 0) {
      addLog("⚠️ Please select at least one year");
      setSubmitting(false);
      setPhase("idle");
      return;
    }

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state,
          district,
          years: selectedYears,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { jobId } = await res.json();
      setJobId(jobId);
      const yearStr = selectedYears.includes("all") ? "all years" : selectedYears.join(", ");
      addLog(`🚀 Started job ${jobId} for ${state}/${district} - ${yearStr}`);
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
    eventSourceRef.current = es;

    es.addEventListener("open", () => {
      addLog("🔌 Connected to job stream.");
    });

    es.addEventListener("error", (evt) => {
      // Only log error if it's not a normal close during finishing phase
      if (!isFinishingRef.current) {
        addLog("⚠️ Stream connection error.");
      }
      es.close();
      // Don't set submitting to false during finishing - let downloads complete
      if (!isFinishingRef.current) {
        setSubmitting(false);
      }
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
        // Don't update filesDownloaded from server - frontend tracks its own downloads
        if (p.startedAt) setStartedAt(p.startedAt);
      } catch {}
    });

    es.addEventListener("file", (evt) => {
      try {
        const f = JSON.parse(evt.data);
        setFiles((prev) => [f, ...prev].slice(0, 1000)); // keep last 1000

        if (autoDownload && f.url && f.year && f.meetingId) {
          // Start download timer on first file
          if (!downloadStartTimeRef.current && downloadQueueRef.current.length === 0) {
            const now = Date.now();
            setDownloadStartTime(now);
            downloadStartTimeRef.current = now;
          }
          downloadQueueRef.current.push(f);
          totalFilesExpectedRef.current++;
          processDownloadQueue(jobId);
        }
      } catch {}
    });

    es.addEventListener("summary", (evt) => {
      try {
        const s = JSON.parse(evt.data);
        setPhase("finishing");
        isFinishingRef.current = true;
        addLog(`📊 Discovery complete. Waiting for ${downloadQueueRef.current.length + activeDownloadsRef.current} remaining downloads...`);
        
        // Wait for all downloads to finish before showing final summary
        const checkComplete = setInterval(() => {
          if (downloadQueueRef.current.length === 0 && activeDownloadsRef.current === 0) {
            clearInterval(checkComplete);
            
            // Store final download metrics using current ref values
            const endTime = Date.now();
            setDownloadEndTime(endTime);
            if (downloadStartTimeRef.current) {
              const totalTime = (endTime - downloadStartTimeRef.current) / 1000;
              const megabytesDownloaded = totalBytesDownloadedRef.current / (1024 * 1024);
              setFinalDownloadTime(totalTime);
              // Guard against division by zero
              if (totalTime > 0) {
                setFinalAvgSpeed(megabytesDownloaded / totalTime);
              }
            }
            
            setEndedAt(s.endedAt || null);
            setElapsed(s.elapsed || null);
            setPhase("done");
            addLog("🎉 All downloads finished!");
            es.close();
            setSubmitting(false);
          }
        }, 500);
      } catch {}
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
                  : phase === "cancelled"
                  ? "#fee2e2"
                  : phase === "idle"
                  ? "#e2e8f0"
                  : "#dbeafe",
              color:
                phase === "done"
                  ? "#166534"
                  : phase === "cancelled"
                  ? "#991b1b"
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
            gridTemplateRows: "auto auto auto auto auto",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div>
            <label style={{ fontSize: 13, fontWeight: 600 }}>State Code</label>
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
            <label style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: "block" }}>
              Year(s) - Select multiple
            </label>
            <div
              style={{
                maxHeight: 180,
                overflowY: "auto",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: "8px",
                background: "#fff",
              }}
            >
              {yearOptions.map((y) => (
                <label
                  key={y}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    cursor: "pointer",
                    borderRadius: 6,
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "#f1f5f9"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <input
                    type="checkbox"
                    checked={selectedYears.includes(y)}
                    onChange={() => handleYearToggle(y)}
                    style={{
                      width: 16,
                      height: 16,
                      cursor: "pointer",
                    }}
                  />
                  <span style={{ fontSize: 14, color: "#334155" }}>
                    {y === "all" ? "All years" : y}
                  </span>
                </label>
              ))}
            </div>
            {selectedYears.length === 0 && (
              <small style={{ color: "#ef4444", fontSize: 12, marginTop: 4, display: "block" }}>
                Please select at least one year
              </small>
            )}
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

          <div style={{ display: "flex", gap: 12, alignItems: "end" }}>
            <button
              type="submit"
              disabled={submitting}
              style={{
                flex: 1,
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
            {submitting && !isCancelling && (
              <button
                type="button"
                onClick={stopDownloads}
                style={{
                  borderRadius: 12,
                  padding: "10px 14px",
                  fontWeight: 600,
                  color: "#fff",
                  background: "#dc2626",
                  cursor: "pointer",
                  border: "none",
                  whiteSpace: "nowrap",
                }}
              >
                Stop Downloads
              </button>
            )}
          </div>
        </form>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <StatCard label="Meetings" value={meetings} />
          <StatCard label="Files Found" value={filesDiscovered} />
          <StatCard label="Downloaded" value={filesDownloaded} />
          <StatCard label="Failed" value={failed} />
          <StatCard 
            label="Speed" 
            value={downloadSpeed > 0 ? `${downloadSpeed.toFixed(2)} MB/s` : "—"} 
          />
          <StatCard 
            label="Download Time" 
            value={currentDownloadTime} 
          />
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
            <div>Discovery: {elapsed || "—"}</div>
            <div>
              Downloads: {filesDownloaded} / {filesDiscovered}
              {filesDiscovered > 0 && ` (${((filesDownloaded / filesDiscovered) * 100).toFixed(1)}%)`}
            </div>
            <div>
              Download Time: {
                finalDownloadTime !== null
                  ? formatTime(finalDownloadTime)
                  : downloadStartTime && phase !== "idle"
                  ? `${formatTime((Date.now() - downloadStartTime) / 1000)} (ongoing)`
                  : "—"
              }
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              {phase === "done" && filesDownloaded > 0 && finalAvgSpeed !== null && (
                <span>
                  Avg Speed: {finalAvgSpeed.toFixed(2)} MB/s
                  {failed > 0 && ` • ${failed} failed`}
                </span>
              )}
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
