import { useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

function pad2(value) {
  return String(value).padStart(2, "0");
}

function secondsToTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0 ? `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
}

function splitIntoSentences(text) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\u2022/g, "•")
    .trim();
  if (!cleaned) return [];

  // Prefer sentence-ish boundaries, but keep it simple and robust.
  const parts = cleaned
    .split(/(?<=[.!?])\s+|(?:\s+[-•]\s+)/g)
    .map((s) => s.trim())
    .filter(Boolean);

  return parts;
}

function extractTimelineItems(sourceText, { secondsPerPoint = 30, maxItems = 200 } = {}) {
  const text = String(sourceText || "").trim();
  if (!text) return [];

  // Timestamped format: [00:00] content
  const timestampRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^\n\r]+)/g;
  const timestamped = [];
  for (const match of text.matchAll(timestampRegex)) {
    const time = match[1];
    const content = String(match[2] || "").trim();
    if (!content) continue;
    timestamped.push({ time, content });
    if (timestamped.length >= maxItems) break;
  }
  if (timestamped.length) return timestamped;

  // No timestamps: approximate by sentences / bullet-like splits.
  const sentences = splitIntoSentences(text).slice(0, maxItems);
  return sentences
    .map((content, idx) => ({
      time: secondsToTimestamp(idx * secondsPerPoint),
      content,
    }))
    .filter((item) => item.content.length >= 3);
}

function toFriendlyError(message) {
  const text = String(message || "").toLowerCase();
  if (
    text.includes("no audio track") ||
    text.includes("matches no streams") ||
    text.includes("output file does not contain any stream")
  ) {
    return "No audio track found in this file. Please upload a file that contains speech audio.";
  }
  if (text.includes("failed to fetch")) {
    return "Cannot reach backend API. Make sure backend is running and retry.";
  }
  if (text.includes("openai_api_key is missing")) {
    return "OPENAI_API_KEY is missing in backend/.env. Add it and restart backend.";
  }
  return message || "Failed to process file.";
}

async function readErrorMessage(response, fallbackText) {
  try {
    const body = await response.json();
    if (body?.detail) return String(body.detail);
  } catch {
    // Non-JSON error response.
  }
  try {
    const text = await response.text();
    if (text) return text;
  } catch {
    // Ignore and use fallback.
  }
  return fallbackText;
}

function App() {
  const [file, setFile] = useState(null);
  const [category, setCategory] = useState("Meeting");
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState(-1);

  const onSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setResult(null);
    setSelectedTimelineIndex(-1);

    if (!file) {
      setError("Please upload an audio/video file.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("category", category);
    formData.append("topic", topic);

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/process`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const detail = await readErrorMessage(response, `Failed to process file (HTTP ${response.status}).`);
        throw new Error(detail);
      }

      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(toFriendlyError(err.message));
    } finally {
      setLoading(false);
    }
  };

  const downloadFile = async (format) => {
    if (!result) return;
    setError("");
    try {
      const response = await fetch(`${API_BASE}/download/${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });

      if (!response.ok) {
        const detail = await readErrorMessage(
          response,
          `Failed to download ${format.toUpperCase()} (HTTP ${response.status}).`
        );
        throw new Error(detail);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `minutes_result.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(toFriendlyError(err.message));
    }
  };

  return (
    <main className="container">
      <h1>AI Minutes Maker</h1>
      <p>Upload recordings and generate transcript + AI summary.</p>

      <form onSubmit={onSubmit} className="card">
        <label>
          File (mp3, wav, mp4, m4a, aac, ogg)
          <input
            type="file"
            accept=".mp3,.wav,.mp4,.m4a,.aac,.ogg"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>

        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="Meeting">Meeting</option>
            <option value="Lecture">Lecture</option>
          </select>
        </label>

        <label>
          Topic (optional)
          <input
            type="text"
            placeholder="e.g., Sprint planning / Data structures"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>

        <button type="submit" disabled={loading}>
          {loading ? "Processing..." : "Generate Minutes"}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {result && (
        <section className="results">
          <div className="card">
            <h2>Short Summary</h2>
            <p>{result.summary.short_summary}</p>
          </div>

          <div className="card">
            <h2>Key Insights</h2>
            <ul>
              {result.summary.key_insights.map((item, idx) => (
                <li key={`insight-${idx}`}>{item}</li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h2>Action Items</h2>
            <ul>
              {result.summary.action_items.length ? (
                result.summary.action_items.map((item, idx) => (
                  <li key={`action-${idx}`}>{item}</li>
                ))
              ) : (
                <li>No action items.</li>
              )}
            </ul>
          </div>

          <div className="card timeline-card">
            <h2>Timeline</h2>
            <div className="timeline" role="list">
              {extractTimelineItems(
                [
                  result.summary.short_summary,
                  ...(result.summary.key_insights || []),
                  ...(result.summary.action_items || []),
                  result.transcript,
                ].join("\n"),
                { secondsPerPoint: 30 }
              ).map((item, idx) => (
                <div
                  key={`timeline-${idx}`}
                  className={`timeline-item${idx === selectedTimelineIndex ? " selected" : ""}`}
                  role="listitem"
                  tabIndex={0}
                  onClick={() => setSelectedTimelineIndex(idx)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setSelectedTimelineIndex(idx);
                  }}
                >
                  <div className="timeline-time">{item.time} →</div>
                  <div className="timeline-content">{item.content}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Full Transcript</h2>
            <textarea value={result.transcript} readOnly rows={12} />
          </div>

          <div className="downloads">
            <button onClick={() => downloadFile("txt")}>Download .txt</button>
            <button onClick={() => downloadFile("pdf")}>Download .pdf</button>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
