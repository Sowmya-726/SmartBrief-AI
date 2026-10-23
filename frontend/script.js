const API_BASE = "/api";

// Frontend no longer uses dummy auth. We keep a small cache key only to avoid flicker
// and to preserve "auth-like" state across refreshes if backend is temporarily down.
const AUTH_KEY = "aimm_auth_cache";

const authState = {
  checked: false,
  authed: false,
  email: "",
};

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function setText(el, value) {
  if (!el) return;
  el.textContent = value == null ? "" : String(value);
}

function getCachedAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function setCachedAuth({ authed, email }) {
  localStorage.setItem(
    AUTH_KEY,
    JSON.stringify({
      authed: Boolean(authed),
      email: email || "",
      at: Date.now(),
    })
  );
}

function clearCachedAuth() {
  localStorage.removeItem(AUTH_KEY);
}

async function refreshAuth() {
  try {
    const response = await fetch(`${API_BASE}/auth/me`, { credentials: "same-origin" });
    if (!response.ok) throw new Error("not authed");
    const data = await response.json();
    authState.checked = true;
    authState.authed = true;
    authState.email = data?.email || "";
    setCachedAuth({ authed: true, email: authState.email });
    return true;
  } catch {
    authState.checked = true;
    authState.authed = false;
    authState.email = "";
    setCachedAuth({ authed: false, email: "" });
    return false;
  }
}

function isAuthed() {
  if (authState.checked) return authState.authed;
  const cached = getCachedAuth();
  return Boolean(cached?.authed);
}

async function guardDashboard() {
  const isDash = location.pathname.endsWith("/dashboard.html");
  if (!isDash) return;
  const ok = await refreshAuth();
  if (!ok) {
    location.replace("/login.html");
  }
}

function wireAuthLinks() {
  // Any link marked data-auth-link should only be usable when authed.
  for (const link of $all("[data-auth-link]")) {
    if (isAuthed()) {
      link.removeAttribute("aria-disabled");
      link.classList.remove("is-disabled");
      link.href = "/dashboard.html";
      continue;
    }
    link.href = "/login.html";
  }

  const logoutBtn = $("[data-logout]");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "same-origin" });
      } catch {
        // Ignore logout network errors.
      } finally {
        clearCachedAuth();
        location.replace("/home.html");
      }
    });
    // Hide logout button if not authed.
    if (!isAuthed()) logoutBtn.style.display = "none";
  }

  const loginLink = $("[data-login-link]");
  if (loginLink && isAuthed()) {
    loginLink.style.display = "none";
  }
}

function wireYear() {
  const year = new Date().getFullYear();
  for (const el of $all("[data-year]")) el.textContent = String(year);
}

function wireLoginPage() {
  const isLogin = location.pathname.endsWith("/login.html");
  if (!isLogin) return;

  // If the backend session is valid, go directly to dashboard.
  refreshAuth().then((ok) => {
    if (ok) location.replace("/dashboard.html");
  });

  const tabs = $all(".tab");
  const panels = $all(".panel");

  function activateTab(tabName) {
    for (const t of tabs) {
      const active = t.dataset.tab === tabName;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const p of panels) {
      p.classList.toggle("is-active", p.dataset.panel === tabName);
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  }

  const forms = $all("[data-auth-form]");
  for (const form of forms) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const email = String(fd.get("email") || "").trim();
      const password = String(fd.get("password") || "");

      const msg = $("[data-form-msg]", form);
      if (!email || !password) {
        if (msg) {
          msg.classList.add("is-error");
          msg.classList.remove("is-ok");
          msg.textContent = "Please enter email and password.";
        }
        return;
      }

      const mode = form.dataset.authForm;
      try {
        if (msg) {
          msg.classList.remove("is-error", "is-ok");
          msg.textContent = "Please wait…";
        }

        if (mode === "signup") {
          const reg = await fetch(`${API_BASE}/auth/register`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          });
          if (!reg.ok) {
            const detail = await readErrorMessage(reg, `Signup failed (HTTP ${reg.status}).`);
            throw new Error(detail);
          }
        }

        const login = await fetch(`${API_BASE}/auth/login`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!login.ok) {
          const detail = await readErrorMessage(login, `Login failed (HTTP ${login.status}).`);
          throw new Error(detail);
        }

        await refreshAuth();

        if (msg) {
          msg.classList.remove("is-error");
          msg.classList.add("is-ok");
          msg.textContent = "Success. Redirecting…";
        }
        setTimeout(() => location.replace("/dashboard.html"), 350);
      } catch (err) {
        if (msg) {
          msg.classList.add("is-error");
          msg.classList.remove("is-ok");
          msg.textContent = String(err?.message || "Authentication failed.");
        }
      }
    });
  }
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

function parseTimestampToSeconds(ts) {
  // Accept mm:ss or hh:mm:ss
  const parts = String(ts || "")
    .trim()
    .split(":")
    .map((v) => Number(v));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) {
    const [mm, ss] = parts;
    return mm * 60 + ss;
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = parts;
    return hh * 3600 + mm * 60 + ss;
  }
  return null;
}

function splitIntoPoints(text) {
  const cleaned = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\u2022/g, "•")
    .trim();
  if (!cleaned) return [];

  // Split by timestamp markers, sentence boundaries, or bullet-like separators.
  const parts = cleaned
    .split(/(?<=[.!?])\s+|(?:\n+)|(?:\s+[-•]\s+)/g)
    .map((s) => s.trim())
    .filter(Boolean);

  // De-duplicate tiny fragments
  return parts.filter((p) => p.length >= 3);
}

function estimateDurationSecondsFromText(text) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  // 150 wpm reading/speaking-ish baseline.
  const minutes = words / 150;
  // Clamp to a reasonable range so "dynamic interval" behaves predictably.
  return Math.max(60, Math.min(45 * 60, Math.round(minutes * 60)));
}

function extractTimelineItems(sourceText, { maxItems = 220 } = {}) {
  const text = String(sourceText || "").trim();
  if (!text) return [];

  // Timestamped format: [00:00] content
  const timestampRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^\n\r]+)/g;
  const timestamped = [];
  for (const match of text.matchAll(timestampRegex)) {
    const time = match[1];
    const content = String(match[2] || "").trim();
    if (!content) continue;
    timestamped.push({ time, seconds: parseTimestampToSeconds(time), content, mode: "timestamp" });
    if (timestamped.length >= maxItems) break;
  }
  if (timestamped.length) return timestamped;

  // No timestamps: generate approximate timeline using dynamic 10–20 sec intervals.
  const points = splitIntoPoints(text).slice(0, maxItems);
  if (!points.length) return [];

  const estimatedDuration = estimateDurationSecondsFromText(text);
  const interval = Math.max(10, Math.min(20, Math.round(estimatedDuration / Math.max(1, points.length))));

  return points.map((content, idx) => ({
    time: secondsToTimestamp(idx * interval),
    seconds: idx * interval,
    content,
    mode: "approx",
  }));
}

function wireDashboardPage() {
  const isDash = location.pathname.endsWith("/dashboard.html");
  if (!isDash) return;

  guardDashboard();

  const form = $("[data-upload-form]");
  const errorEl = $("[data-error]");
  const okEl = $("[data-ok]");
  const output = $("[data-output]");
  const generateBtn = $("[data-generate]");
  const generateText = $("[data-generate-text]");

  const shortSummaryEl = $("[data-short-summary]");
  const keyInsightsEl = $("[data-key-insights]");
  const actionItemsEl = $("[data-action-items]");
  const transcriptEl = $("[data-transcript]");
  const timelineEl = $("[data-timeline]");

  const downloadBtns = $all("[data-download]");

  let lastResult = null;
  let selectedTimelineIndex = -1;

  function setLoading(isLoading) {
    if (!generateBtn) return;
    generateBtn.disabled = isLoading;
    generateBtn.classList.toggle("is-loading", isLoading);
    if (generateText) generateText.textContent = isLoading ? "Processing…" : "Generate Summary";
  }

  function setError(msg) {
    if (errorEl) errorEl.textContent = msg || "";
    if (okEl) okEl.textContent = "";
  }

  function setOk(msg) {
    if (okEl) okEl.textContent = msg || "";
    if (errorEl) errorEl.textContent = "";
  }

  function renderList(ul, items, emptyText) {
    if (!ul) return;
    ul.innerHTML = "";
    if (!items || !items.length) {
      const li = document.createElement("li");
      li.textContent = emptyText || "None.";
      ul.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = String(item);
      ul.appendChild(li);
    }
  }

  function renderTimeline(items) {
    if (!timelineEl) return;
    timelineEl.innerHTML = "";
    selectedTimelineIndex = -1;

    for (const [idx, item] of items.entries()) {
      const row = document.createElement("div");
      row.className = "timeline-item";
      row.setAttribute("role", "listitem");
      row.tabIndex = 0;

      const time = document.createElement("div");
      time.className = "timeline-time";
      time.textContent = `${item.time} →`;

      const content = document.createElement("div");
      content.className = "timeline-content";
      content.textContent = item.content;

      function select() {
        selectedTimelineIndex = idx;
        for (const el of $all(".timeline-item", timelineEl)) el.classList.remove("is-selected");
        row.classList.add("is-selected");
      }

      row.addEventListener("click", select);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") select();
      });

      row.appendChild(time);
      row.appendChild(content);
      timelineEl.appendChild(row);
    }
  }

  async function downloadFile(format) {
    if (!lastResult) return;
    setError("");
    try {
      const response = await fetch(`${API_BASE}/download/${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastResult),
      });
      if (!response.ok) {
        const detail = await readErrorMessage(response, `Failed to download ${format.toUpperCase()} (HTTP ${response.status}).`);
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
      setError(toFriendlyError(err?.message));
    }
  }

  for (const btn of downloadBtns) {
    btn.addEventListener("click", () => downloadFile(btn.dataset.download));
  }

  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("");
    setOk("");
    if (output) output.hidden = true;
    lastResult = null;
    for (const btn of downloadBtns) btn.disabled = true;

    const fd = new FormData(form);
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) {
      setError("Please upload an audio/video file.");
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", String(fd.get("category") || "Meeting"));
      formData.append("topic", String(fd.get("topic") || ""));

      const response = await fetch(`${API_BASE}/process`, { method: "POST", body: formData });
      if (!response.ok) {
        const detail = await readErrorMessage(response, `Failed to process file (HTTP ${response.status}).`);
        throw new Error(detail);
      }
      const data = await response.json();
      lastResult = data;

      // Render summary exactly from existing backend response shape.
      setText(shortSummaryEl, data?.summary?.short_summary || "");
      renderList(keyInsightsEl, data?.summary?.key_insights || [], "No key insights.");
      renderList(actionItemsEl, data?.summary?.action_items || [], "No action items.");
      if (transcriptEl) transcriptEl.value = String(data?.transcript || "");

      const sourceText = [
        data?.summary?.short_summary || "",
        ...(data?.summary?.key_insights || []),
        ...(data?.summary?.action_items || []),
        data?.transcript || "",
      ].join("\n");
      const timeline = extractTimelineItems(sourceText);
      renderTimeline(timeline);

      if (output) output.hidden = false;
      for (const btn of downloadBtns) btn.disabled = false;
      setOk("Done.");
    } catch (err) {
      setError(toFriendlyError(err?.message));
    } finally {
      setLoading(false);
    }
  });
}

function wireHomePage() {
  const isHome = location.pathname.endsWith("/home.html");
  if (!isHome) return;

  // If authed, keep "Go to Dashboard" on dashboard.
  for (const link of $all("[data-auth-link]")) {
    link.href = isAuthed() ? "/dashboard.html" : "/login.html";
  }
}

async function init() {
  wireYear();
  // On any page load, validate session once (so links + guards are accurate).
  await refreshAuth();

  // Guard after refreshAuth to ensure correctness.
  await guardDashboard();
  wireAuthLinks();
  wireHomePage();
  wireLoginPage();
  wireDashboardPage();
}

init();
