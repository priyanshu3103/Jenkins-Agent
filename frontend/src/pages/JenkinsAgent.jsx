import { useState, useEffect, useCallback, useRef } from "react";

// ─── Config ────────────────────────────────────────────────────────────────
const STORAGE_KEY = "jenkins_agent_backend_url";
const DEFAULT_URL = (typeof window !== "undefined" && window.JENKINS_API_URL) || "http://localhost:8000";

// ─── Helpers ───────────────────────────────────────────────────────────────
const timeAgo = (ts) => {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
const formatDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  return s > 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const avatarColor = (name = "") => {
  const colors = ["#e05252","#e08c52","#52a8e0","#52c4a8","#a852e0","#e052a8"];
  let h = 0;
  for (let c of name) h = (h + c.charCodeAt(0)) % colors.length;
  return colors[h];
};
const severityColor = (s) =>
  ({ Critical:"#ff4444", High:"#ff8800", Medium:"#ffcc00", Low:"#44cc88" }[s] || "#888");

// ─── Small components ──────────────────────────────────────────────────────
const Avatar = ({ name = "?", size = 32 }) => (
  <div style={{
    width: size, height: size, borderRadius: "50%", background: avatarColor(name),
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontWeight: 700, fontSize: size * 0.38, flexShrink: 0,
    fontFamily: "monospace", border: "2px solid rgba(255,255,255,0.12)"
  }}>
    {name.split(" ").map(n => n[0]).join("").slice(0, 2)}
  </div>
);

const Spinner = ({ size = 14, color = "#f85149" }) => (
  <div style={{
    width: size, height: size, border: `2px solid #30363d`,
    borderTopColor: color, borderRadius: "50%",
    animation: "spin 0.8s linear infinite", flexShrink: 0,
  }} />
);

// ─── API helpers ───────────────────────────────────────────────────────────
async function apiFetch(baseUrl, path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// ─── Main Component ────────────────────────────────────────────────────────
export default function JenkinsAgent() {
  const savedUrl = typeof window !== "undefined" ? (localStorage.getItem(STORAGE_KEY) || DEFAULT_URL) : DEFAULT_URL;

  const [step, setStep]             = useState("connect");
  const [backendUrl, setBackendUrl] = useState(savedUrl);
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError]   = useState("");

  const [builds, setBuilds]               = useState([]);
  const [loadingBuilds, setLoadingBuilds] = useState(false);
  const [fetchError, setFetchError]       = useState("");

  const [selected, setSelected]           = useState(null);
  const [detail, setDetail]               = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [analysis, setAnalysis]   = useState({});
  const [analyzing, setAnalyzing] = useState(null);
  const pollRef = useRef(null);

  // ── Auto-connect on mount if URL was previously saved ────────────────────
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    setConnecting(true);
    apiFetch(stored, "/health")
      .then(() => {
        setBackendUrl(stored);
        setStep("dashboard");
      })
      .catch(() => {
        // Backend unreachable — stay on connect screen, don't wipe saved URL
      })
      .finally(() => setConnecting(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Manual connect ────────────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnError("");
    try {
      await apiFetch(backendUrl, "/health");
      localStorage.setItem(STORAGE_KEY, backendUrl);
      setStep("dashboard");
    } catch (e) {
      setConnError(`Cannot reach backend at ${backendUrl}.\nMake sure agent.py is running.\n\n${e.message}`);
    } finally {
      setConnecting(false);
    }
  }, [backendUrl]);

  // ── Disconnect ────────────────────────────────────────────────────────────
  const handleDisconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    clearInterval(pollRef.current);
    setStep("connect");
    setBuilds([]);
    setSelected(null);
    setDetail(null);
    setAnalysis({});
    setConnError("");
  }, []);

  // ── Fetch builds ──────────────────────────────────────────────────────────
  const fetchBuilds = useCallback(async () => {
    setLoadingBuilds(true);
    setFetchError("");
    try {
      const data = await apiFetch(backendUrl, "/api/builds");
      const list = data.builds || [];
      setBuilds(list);
      setAnalysis(prev => {
        const next = { ...prev };
        for (const b of list) if (b.analysis) next[b.id] = b.analysis;
        return next;
      });
    } catch (e) {
      setFetchError(e.message);
    } finally {
      setLoadingBuilds(false);
    }
  }, [backendUrl]);

  useEffect(() => {
    if (step !== "dashboard") return;
    fetchBuilds();
    pollRef.current = setInterval(fetchBuilds, 60_000);
    return () => clearInterval(pollRef.current);
  }, [step]);

  // ── Select build ──────────────────────────────────────────────────────────
  const selectBuild = useCallback(async (build) => {
    setSelected(build.id);
    setDetail(null);
    setLoadingDetail(true);
    try {
      const full = await apiFetch(backendUrl, `/api/builds/${build.job}/${build.number}`);
      setDetail(full);
      if (full.analysis) setAnalysis(prev => ({ ...prev, [build.id]: full.analysis }));
    } catch {
      setDetail(build);
    } finally {
      setLoadingDetail(false);
    }
    if (!analysis[build.id]) triggerAnalysis(build);
  }, [backendUrl, analysis]);

  // ── Analyze ───────────────────────────────────────────────────────────────
  const triggerAnalysis = useCallback(async (build) => {
    setAnalyzing(build.id);
    try {
      const data = await apiFetch(backendUrl, "/api/analyze", {
        method: "POST",
        body: JSON.stringify({ job: build.job, build_number: build.number }),
      });
      if (data.analysis) setAnalysis(prev => ({ ...prev, [build.id]: data.analysis }));
    } catch (e) {
      console.error("Analysis failed:", e.message);
    } finally {
      setAnalyzing(null);
    }
  }, [backendUrl]);

  const currentBuild    = detail || builds.find(b => b.id === selected);
  const currentAnalysis = selected ? analysis[selected] : null;

  return (
    <div style={{
      height: "100vh", width: "100vw", background: "#0d1117", color: "#e6edf3",
      fontFamily: "'JetBrains Mono','Fira Code',monospace",
      display: "flex", flexDirection: "column",
      overflow: "hidden", position: "fixed", top: 0, left: 0,
    }}>
      <style>{`
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes spin   { to{transform:rotate(360deg)} }
        @keyframes slideIn{ from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        ::-webkit-scrollbar{width:6px}
        ::-webkit-scrollbar-track{background:#0d1117}
        ::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
        a{color:#79c0ff}
      `}</style>

      {/* ── Header ── */}
      <div style={{
        padding: "13px 22px", borderBottom: "1px solid #21262d",
        background: "#161b22", display: "flex", alignItems: "center",
        justifyContent: "space-between", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, fontSize: 16,
            background: "linear-gradient(135deg,#f85149,#ff6b6b)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>⚙</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Jenkins Failure Agent</div>
            <div style={{ fontSize: 10, color: "#8b949e", display: "flex", alignItems: "center", gap: 8 }}>
              {step === "connect" ? (
                connecting ? "Reconnecting…" : "Connect backend to start"
              ) : (
                <>
                  <span>{backendUrl} · live</span>
                  <button onClick={handleDisconnect} style={{
                    background: "none", border: "1px solid #30363d", borderRadius: 4,
                    color: "#8b949e", fontSize: 10, padding: "1px 6px",
                    cursor: "pointer", fontFamily: "inherit",
                  }}>disconnect</button>
                </>
              )}
            </div>
          </div>
        </div>

        {step === "dashboard" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={fetchBuilds} disabled={loadingBuilds} style={{
              padding: "5px 11px", borderRadius: 6, border: "1px solid #30363d",
              background: "transparent", color: "#8b949e", cursor: "pointer",
              fontSize: 11, fontFamily: "inherit", display: "flex", gap: 5, alignItems: "center",
            }}>
              {loadingBuilds ? <Spinner size={10} color="#8b949e" /> : "↺"} Refresh
            </button>
            {["dashboard","settings"].map(v => (
              <button key={v} onClick={() => setStep(v)} style={{
                padding: "5px 11px", borderRadius: 6, border: "none", cursor: "pointer",
                background: step === v ? "#21262d" : "transparent",
                color: step === v ? "#e6edf3" : "#8b949e",
                fontSize: 11, fontFamily: "inherit",
              }}>{v === "dashboard" ? "📊 Dashboard" : "⚙ Config"}</button>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#3fb950", marginLeft: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#3fb950", animation: "pulse 2s infinite" }} />
              {builds.length} failures
            </div>
          </div>
        )}
      </div>

      {/* ── Connect screen ── */}
      {step === "connect" && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
          <div style={{
            background: "#161b22", border: "1px solid #30363d", borderRadius: 16,
            padding: 40, maxWidth: 460, width: "100%", animation: "slideIn 0.3s ease",
          }}>
            <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>
              {connecting ? "🔄" : "🔴"}
            </div>
            <h2 style={{ margin: "0 0 6px", textAlign: "center", fontSize: 20, fontWeight: 700 }}>
              {connecting ? "Connecting…" : "Connect to Jenkins Agent"}
            </h2>
            <p style={{ color: "#8b949e", fontSize: 12, textAlign: "center", margin: "0 0 26px", lineHeight: 1.6 }}>
              Enter the URL where <code style={{ color: "#79c0ff" }}>Jenkins</code> is running.
            </p>

            <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 5 }}>Backend URL</label>
            <input
              value={backendUrl}
              onChange={e => setBackendUrl(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleConnect()}
              placeholder="http://localhost:8000"
              disabled={connecting}
              style={{
                width: "100%", padding: "10px 13px", borderRadius: 8, boxSizing: "border-box",
                background: "#0d1117", border: "1px solid #30363d", color: "#e6edf3",
                fontSize: 13, fontFamily: "inherit", marginBottom: 14, outline: "none",
                opacity: connecting ? 0.5 : 1,
              }}
            />

            {connError && (
              <div style={{
                background: "#2d1010", border: "1px solid #f85149", borderRadius: 8,
                padding: "10px 13px", marginBottom: 14, fontSize: 11,
                color: "#f85149", whiteSpace: "pre-wrap", lineHeight: 1.6,
              }}>{connError}</div>
            )}

            <div style={{
              background: "#1c2128", border: "1px solid #30363d", borderRadius: 8,
              padding: "10px 14px", marginBottom: 18, fontSize: 11, color: "#8b949e", lineHeight: 1.8,
            }}>
              <strong style={{ color: "#e6edf3" }}>Start the backend first:</strong><br />
              <code style={{ color: "#79c0ff" }}>pip install fastapi uvicorn requests python-dotenv</code><br />
              <code style={{ color: "#79c0ff" }}>python agent.py</code>
            </div>

            <button onClick={handleConnect} disabled={connecting} style={{
              width: "100%", padding: "11px 0", borderRadius: 8, border: "none",
              background: connecting ? "#21262d" : "linear-gradient(135deg,#f85149,#da3633)",
              color: "#fff", fontWeight: 700, fontSize: 14, cursor: connecting ? "not-allowed" : "pointer",
              fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}>
              {connecting ? <><Spinner size={14} color="#fff" /> Connecting…</> : "🔌 Connect"}
            </button>
          </div>
        </div>
      )}

      {/* ── Settings ── */}
      {step === "settings" && (
        <div style={{ flex: 1, padding: 32, maxWidth: 560, margin: "0 auto", width: "100%" }}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Configuration</h3>
          {[
            ["Backend URL",     backendUrl],
            ["Auto-refresh",    "Every 60 seconds"],
            ["Analysis engine", "Gemini (via backend)"],
            ["Slack alerts",    "Configured in .env on backend"],
            ["Session",         "URL saved in localStorage"],
          ].map(([label, val]) => (
            <div key={label} style={{
              display: "flex", justifyContent: "space-between",
              padding: "12px 0", borderBottom: "1px solid #21262d", fontSize: 13,
            }}>
              <span style={{ color: "#8b949e" }}>{label}</span>
              <span>{val}</span>
            </div>
          ))}
          <button onClick={handleDisconnect} style={{
            marginTop: 24, padding: "8px 16px", borderRadius: 8,
            border: "1px solid #f85149", background: "transparent",
            color: "#f85149", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
          }}>
            🔌 Disconnect & clear saved URL
          </button>
          <div style={{
            marginTop: 22, padding: 16, background: "#161b22",
            borderRadius: 10, border: "1px solid #30363d", fontSize: 11, color: "#8b949e", lineHeight: 1.9,
          }}>
            <strong style={{ color: "#e6edf3" }}>Backend API endpoints</strong><br />
            <code style={{ color: "#79c0ff" }}>GET  /api/builds</code> — all failed builds<br />
            <code style={{ color: "#79c0ff" }}>GET  /api/builds/&#123;job&#125;/&#123;num&#125;</code> — detail + console<br />
            <code style={{ color: "#79c0ff" }}>POST /api/analyze</code> — trigger Gemini analysis<br />
            <code style={{ color: "#79c0ff" }}>GET  /health</code> — connectivity check
          </div>
        </div>
      )}

      {/* ── Dashboard ── */}
      {step === "dashboard" && (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* Build list */}
          <div style={{ width: 310, flexShrink: 0, borderRight: "1px solid #21262d", overflowY: "auto" }}>
            <div style={{ padding: "13px 16px 7px", fontSize: 10, color: "#8b949e", letterSpacing: 1, textTransform: "uppercase" }}>
              Failed Builds · {builds.length}
            </div>

            {fetchError && (
              <div style={{ margin: "0 12px 12px", padding: "10px 13px", background: "#2d1010", border: "1px solid #f85149", borderRadius: 8, fontSize: 11, color: "#f85149" }}>
                ⚠ {fetchError}
              </div>
            )}
            {loadingBuilds && !builds.length && (
              <div style={{ display: "flex", justifyContent: "center", padding: 28 }}>
                <Spinner size={20} />
              </div>
            )}
            {!loadingBuilds && !builds.length && !fetchError && (
              <div style={{ padding: "28px 16px", textAlign: "center", color: "#8b949e", fontSize: 13 }}>
                🟢 No failures found
              </div>
            )}

            {builds.map(b => (
              <div key={b.id} onClick={() => selectBuild(b)} style={{
                padding: "12px 16px", cursor: "pointer",
                borderLeft: `3px solid ${selected === b.id ? "#f85149" : "transparent"}`,
                background: selected === b.id ? "#161b22" : "transparent",
                borderBottom: "1px solid #21262d", transition: "all 0.12s",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {b.job} <span style={{ color: "#8b949e" }}>#{b.number}</span>
                  </span>
                  <span style={{ fontSize: 10, color: "#8b949e" }}>{timeAgo(b.timestamp)}</span>
                </div>
                <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>🌿 {b.branch || "unknown"}</div>
                <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>
                  {b.triggerType === "user" ? "👤" : b.triggerType === "timer" ? "⏰" : b.triggerType === "scm" ? "🔀" : "▶"} Triggered by: <span style={{color:"#c9d1d9"}}>{b.triggeredBy || "unknown"}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Avatar name={b.authorName || "?"} size={19} />
                  <span style={{ fontSize: 11, color: "#8b949e" }}>{b.authorName || "unknown"}</span>
                  {analysis[b.id] && (
                    <span style={{
                      marginLeft: "auto", fontSize: 10, padding: "2px 7px", borderRadius: 20,
                      background: severityColor(analysis[b.id].severity) + "22",
                      color: severityColor(analysis[b.id].severity), fontWeight: 700,
                    }}>{analysis[b.id].severity}</span>
                  )}
                  {analyzing === b.id && <div style={{ marginLeft: "auto" }}><Spinner size={11} /></div>}
                </div>
              </div>
            ))}
          </div>

          {/* Detail panel */}
          {currentBuild ? (
            <div style={{ flex: 1, overflowY: "auto", padding: 26, animation: "slideIn 0.2s ease" }}>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#f85149" }} />
                    <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>
                      {currentBuild.job} <span style={{ color: "#8b949e" }}>#{currentBuild.number}</span>
                    </h2>
                    {loadingDetail && <Spinner size={13} />}
                  </div>
                  <div style={{ fontSize: 12, color: "#8b949e" }}>
                    🌿 {currentBuild.branch} · ⏱ {formatDuration(currentBuild.duration)} · {timeAgo(currentBuild.timestamp)}
                    {currentBuild.url && (
                      <a href={currentBuild.url} target="_blank" rel="noreferrer" style={{ marginLeft: 10, fontSize: 11 }}>
                        ↗ Open in Jenkins
                      </a>
                    )}
                  </div>
                </div>
                <button onClick={() => triggerAnalysis(currentBuild)} disabled={analyzing === currentBuild.id} style={{
                  padding: "7px 13px", borderRadius: 8, border: "1px solid #30363d",
                  background: "#161b22", color: "#e6edf3", cursor: "pointer",
                  fontSize: 11, fontFamily: "inherit", display: "flex", gap: 5, alignItems: "center",
                }}>
                  {analyzing === currentBuild.id ? <><Spinner size={11} /> Analyzing…</> : "🤖 Re-analyze"}
                </button>
              </div>

              {/* Triggered By */}
              {currentBuild.triggeredBy && (
                <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 10, padding: 14, marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 22 }}>
                    {currentBuild.triggerType === "user" ? "👤" : currentBuild.triggerType === "timer" ? "⏰" : currentBuild.triggerType === "scm" ? "🔀" : currentBuild.triggerType === "upstream" ? "🔗" : "▶"}
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Triggered By</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{currentBuild.triggeredBy}</div>
                    <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2, textTransform: "capitalize" }}>{currentBuild.triggerType?.replace("_", " ")} trigger</div>
                  </div>
                </div>
              )}

              {/* Responsible dev */}
              <div style={{ background: "#161b22", border: "1px solid #f85149", borderRadius: 12, padding: 18, marginBottom: 18 }}>
                <div style={{ fontSize: 10, color: "#f85149", letterSpacing: 1, textTransform: "uppercase", marginBottom: 11 }}>
                  ⚠ Responsible Developer
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: currentAnalysis ? 11 : 0 }}>
                  <Avatar name={currentBuild.authorName || "?"} size={42} />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{currentBuild.authorName || "unknown"}</div>
                    {currentBuild.author && <div style={{ fontSize: 11, color: "#8b949e" }}>{currentBuild.author}</div>}
                    {currentBuild.commit && (
                      <div style={{ fontSize: 11, color: "#79c0ff", marginTop: 2 }}>
                        {currentBuild.commit} · "{currentBuild.commitMessage}"
                      </div>
                    )}
                  </div>
                  {currentAnalysis && (
                    <div style={{
                      marginLeft: "auto", padding: "5px 13px", borderRadius: 20,
                      background: severityColor(currentAnalysis.severity) + "22",
                      color: severityColor(currentAnalysis.severity), fontWeight: 700, fontSize: 13,
                    }}>{currentAnalysis.severity}</div>
                  )}
                </div>
                {currentAnalysis?.responsibility && (
                  <div style={{ fontSize: 13, color: "#c9d1d9", lineHeight: 1.6, paddingTop: 11, borderTop: "1px solid #30363d" }}>
                    {currentAnalysis.responsibility}
                  </div>
                )}
              </div>

              {/* Analysis */}
              {currentAnalysis ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13, marginBottom: 14 }}>
                    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 10, padding: 15 }}>
                      <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 7, textTransform: "uppercase", letterSpacing: 1 }}>Root Cause</div>
                      <div style={{ fontSize: 13, lineHeight: 1.5 }}>{currentAnalysis.rootCause}</div>
                    </div>
                    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 10, padding: 15 }}>
                      <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 7, textTransform: "uppercase", letterSpacing: 1 }}>Est. Fix Time</div>
                      <div style={{ fontSize: 19, fontWeight: 700, color: "#3fb950" }}>{currentAnalysis.estimatedFixTime}</div>
                    </div>
                  </div>
                  <div style={{ background: "#1c2128", border: "1px solid #3fb950", borderRadius: 10, padding: 15, marginBottom: 14 }}>
                    <div style={{ fontSize: 10, color: "#3fb950", letterSpacing: 1, textTransform: "uppercase", marginBottom: 7 }}>✅ Recommended Fix</div>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>{currentAnalysis.fix}</div>
                  </div>
                  {currentAnalysis.tags?.length > 0 && (
                    <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
                      {currentAnalysis.tags.map(t => (
                        <span key={t} style={{ padding: "3px 9px", borderRadius: 20, background: "#21262d", color: "#8b949e", fontSize: 11 }}>#{t}</span>
                      ))}
                    </div>
                  )}
                </>
              ) : analyzing === currentBuild.id ? (
                <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 10, padding: 26, textAlign: "center", color: "#8b949e", marginBottom: 14 }}>
                  <div style={{ fontSize: 28, marginBottom: 9 }}>🤖</div>
                  <div style={{ fontSize: 13 }}>Gemini is analyzing the failure…</div>
                </div>
              ) : null}

              {/* Console */}
              {currentBuild.console ? (
                <div style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "8px 13px", background: "#161b22", borderBottom: "1px solid #30363d", fontSize: 10, color: "#8b949e", letterSpacing: 1 }}>
                    CONSOLE OUTPUT
                  </div>
                  <pre style={{ margin: 0, padding: 14, fontSize: 11, color: "#8b949e", lineHeight: 1.7, overflowX: "auto", whiteSpace: "pre-wrap" }}>
                    {currentBuild.console.split("\n").map((line, i) => (
                      <span key={i} style={{
                        display: "block",
                        color: line.match(/FAILURE|ERROR|Exception/i) ? "#f85149"
                          : line.match(/SUCCESS/i) ? "#3fb950"
                          : line.match(/FAIL|WARN/i) ? "#ff8800"
                          : undefined,
                      }}>{line}</span>
                    ))}
                  </pre>
                </div>
              ) : loadingDetail ? (
                <div style={{ display: "flex", justifyContent: "center", padding: 22 }}>
                  <Spinner size={18} color="#30363d" />
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8b949e" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 42, marginBottom: 11 }}>🔍</div>
                <div style={{ fontSize: 13 }}>Select a failed build to inspect</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}