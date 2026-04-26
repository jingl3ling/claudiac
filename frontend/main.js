const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const baseUrlEl = /** @type {HTMLInputElement} */ ($("baseUrl"));
const connectBtn = /** @type {HTMLButtonElement} */ ($("connectBtn"));
const ecgSourceEl = /** @type {HTMLSelectElement} */ ($("ecgSource"));
const deviceIdEl = /** @type {HTMLInputElement} */ ($("deviceId"));

const bpmValueEl = $("bpmValue");
const statusTextEl = $("statusText");
const sourceTextEl = $("sourceText");
const errorBoxEl = $("errorBox");
const heartEl = $("heart");
const glowEl = $("glow");
const demoButtonsEl = $("demoButtons");
const waveCanvas = /** @type {HTMLCanvasElement} */ ($("waveCanvas"));
const waveRefreshBtn = /** @type {HTMLButtonElement} */ ($("waveRefreshBtn"));
const waveInfoTextEl = $("waveInfoText");

const stop0 = /** @type {SVGStopElement} */ (document.getElementById("hgStop0"));
const stop1 = /** @type {SVGStopElement} */ (document.getElementById("hgStop1"));
const stop2 = /** @type {SVGStopElement} */ (document.getElementById("hgStop2"));

let timer = null;
let lastBpm = null;
let demoMode = false;

let waveTimer = null;
let lastWaveMtime = 0;

let attackTimer = null;
let attackPhase = false;

const STALE_AFTER_MS = 4000;
let lastGoodAt = 0;

function setError(message) {
  if (!message) {
    errorBoxEl.hidden = true;
    errorBoxEl.textContent = "";
    return;
  }
  errorBoxEl.hidden = false;
  errorBoxEl.textContent = message;
}

function setStatus(text, kind = "muted") {
  statusTextEl.textContent = text;
  statusTextEl.style.color =
    kind === "ok" ? "var(--ok)" : kind === "warn" ? "var(--warn)" : "var(--muted)";
}

function setIdle(isIdle) {
  const v = isIdle ? "idle" : "live";
  heartEl.dataset.state = v;
  glowEl.dataset.state = v;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function bpmToBeatSeconds(bpm) {
  const seconds = 60 / bpm;
  return clamp(seconds, 0.33, 1.6);
}

function applyBpm(bpm, sourceLabel) {
  bpmValueEl.textContent = String(Math.round(bpm));
  sourceTextEl.textContent = sourceLabel || "—";
  document.documentElement.style.setProperty("--beat", `${bpmToBeatSeconds(bpm)}s`);
  setIdle(false);
}

function stopAttackMode() {
  document.documentElement.dataset.demo = "";
  if (attackTimer) window.clearInterval(attackTimer);
  attackTimer = null;
  attackPhase = false;
}

function setThemeAccent(hex) {
  // Soft glow alpha chosen to match the original look.
  document.documentElement.style.setProperty("--accent", hex);
  document.documentElement.style.setProperty("--accentSoft", `${hex}52`);

  // Update SVG gradient stops to use the accent color (with a little “chrome” variety).
  stop0.setAttribute("stop-color", "#ffffff");
  stop1.setAttribute("stop-color", hex);
  stop2.setAttribute("stop-color", hex);
}

const EMOTIONS = [
  { key: "heart-attack", label: "Heart Attack", swatch: "#ff0000", mode: "attack" },
  { key: "anger", label: "Anger", swatch: "#FF0000" },
  { key: "anxiety", label: "Anxiety", swatch: "#FF8C00" },
  { key: "fear", label: "Fear", swatch: "#8A2BE2" },
  { key: "joy", label: "Joy", swatch: "#FFD700" },
  { key: "envy", label: "Envy", swatch: "#00CED1" },
  { key: "disgust", label: "Disgust", swatch: "#32CD32" },
  { key: "embarrassment", label: "Embarrassment", swatch: "#FF69B4" },
  { key: "ennui", label: "Ennui", swatch: "#3A3B5C" },
  { key: "sadness", label: "Sadness", swatch: "#4169E1" },
];

function renderDemoButtons() {
  demoButtonsEl.innerHTML = "";
  for (const emo of EMOTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill";
    btn.dataset.key = emo.key;
    btn.innerHTML = `<span class="name">${emo.label}</span><span class="swatch" aria-hidden="true"></span>`;
    const sw = /** @type {HTMLElement} */ (btn.querySelector(".swatch"));
    sw.style.background = emo.mode === "attack" ? "linear-gradient(90deg, #ff0000, #000000)" : emo.swatch;
    btn.addEventListener("click", () => applyEmotionDemo(emo));
    demoButtonsEl.appendChild(btn);
  }
}

function applyEmotionDemo(emo) {
  // A demo selection should “stick” until the user explicitly reconnects.
  // Otherwise the polling loop will immediately overwrite the theme.
  if (timer) window.clearInterval(timer);
  timer = null;
  if (waveTimer) window.clearInterval(waveTimer);
  waveTimer = null;

  demoMode = true;
  lastBpm = null;
  lastGoodAt = 0;
  setError("");
  setStatus("demo (emotion)", "warn");

  if (emo.mode === "attack") {
    stopAttackMode();
    document.documentElement.dataset.demo = "heart-attack";
    // Flash by swapping the heart fill between red and black quickly.
    attackTimer = window.setInterval(() => {
      attackPhase = !attackPhase;
      const c = attackPhase ? "#000000" : "#ff0000";
      stop0.setAttribute("stop-color", c);
      stop1.setAttribute("stop-color", c);
      stop2.setAttribute("stop-color", c);
      document.documentElement.style.setProperty("--accent", "#ff0000");
      document.documentElement.style.setProperty("--accentSoft", "rgba(255,0,0,0.42)");
    }, 180);

    applyBpm(170, "demo: Heart Attack");
    return;
  }

  stopAttackMode();
  document.documentElement.dataset.demo = emo.key;
  setThemeAccent(emo.swatch);
  applyBpm(72, `demo: ${emo.label}`);
}

async function fetchFromClaudiacOnce() {
  // If the user picked a demo, keep it running until they hit Connect.
  if (demoMode) return;

  const baseUrl = baseUrlEl.value.trim().replace(/\/+$/, "");
  const source = ecgSourceEl.value;
  const deviceId = deviceIdEl.value.trim();
  if (!baseUrl) {
    setStatus("missing config", "warn");
    setError("Please enter the backend base URL (e.g. http://localhost:5100).");
    setIdle(true);
    return;
  }

  const url = new URL(`${baseUrl}/api/analyze`);
  url.searchParams.set("source", source);
  if (source === "upload") url.searchParams.set("deviceId", deviceId);
  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${bodyText ? ` — ${bodyText}` : ""}`);
    }

    // Expected shape: { heart_rate: { bpm: number|null, ... }, mood: {...}, ... }
    const data = await res.json();
    const rawBpm = data?.heart_rate?.bpm;
    // Important: `Number(null) === 0` in JavaScript, but JSON `null` means "unknown" here.
    const bpm = rawBpm === null || rawBpm === undefined ? Number.NaN : Number(rawBpm);

    stopAttackMode();
    demoMode = false;
    setThemeAccent(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff2d55");

    setError("");

    if (Number.isFinite(bpm) && bpm > 0) {
      setStatus("connected", "ok");
      applyBpm(bpm, `/api/analyze?source=${source}${source === "upload" ? `&deviceId=${encodeURIComponent(deviceId)}` : ""}`);
      lastBpm = bpm;
      lastGoodAt = Date.now();
      return;
    }

    // Server may return `null` bpm for very short/weak captures (e.g. early DAQ/iOS window).
    bpmValueEl.textContent = "—";
    sourceTextEl.textContent = "connected (no bpm yet)";
    setStatus("connected (analyzing…)", "warn");
    setIdle(true);
    lastBpm = null;
    lastGoodAt = Date.now();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    const isStale = !lastGoodAt || now - lastGoodAt > STALE_AFTER_MS;

    setStatus(demoMode ? "demo (emotion)" : "reconnecting…", "warn");
    setError(`Backend unavailable.\n${msg}`);

    if (isStale && typeof lastBpm !== "number") {
      setIdle(true);
      sourceTextEl.textContent = "—";
      return;
    }

    if (typeof lastBpm === "number") {
      document.documentElement.style.setProperty("--beat", `${bpmToBeatSeconds(lastBpm)}s`);
      setIdle(false);
    } else {
      setIdle(true);
    }
  }
}

function drawWaveform(samples) {
  const ctx = waveCanvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = waveCanvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (waveCanvas.width !== w) waveCanvas.width = w;
  if (waveCanvas.height !== h) waveCanvas.height = h;

  ctx.clearRect(0, 0, w, h);

  // Background grid
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  const gridX = 10;
  const gridY = 6;
  for (let i = 1; i < gridX; i++) {
    const x = Math.round((w * i) / gridX) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let i = 1; i < gridY; i++) {
    const y = Math.round((h * i) / gridY) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (!samples?.length) return;

  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = -1;
    max = 1;
  }
  // Pad so trace doesn't touch edges.
  const pad = (max - min) * 0.1;
  min -= pad;
  max += pad;

  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff2d55";
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const n = samples.length;
  const xScale = (w - 2) / Math.max(1, n - 1);
  const yScale = (h - 2) / (max - min);

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = 1 + i * xScale;
    const y = 1 + (max - samples[i]) * yScale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

async function fetchWaveformOnce(force = false) {
  if (demoMode) return;
  const baseUrl = baseUrlEl.value.trim().replace(/\/+$/, "");
  if (!baseUrl) return;
  const source = ecgSourceEl.value;
  const deviceId = deviceIdEl.value.trim();

  try {
    const waveUrl = new URL(`${baseUrl}/api/waveform`);
    waveUrl.searchParams.set("source", source);
    if (source === "upload") waveUrl.searchParams.set("deviceId", deviceId);

    const res = await fetch(waveUrl.toString(), { cache: "no-store" });
    if (!res.ok) {
      if (res.status === 404) {
        waveInfoTextEl.textContent = "no live capture yet";
        drawWaveform([]);
        return;
      }
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const mtime = Number(data?.mtime ?? 0);
    if (!force && mtime && mtime === lastWaveMtime) return;
    lastWaveMtime = mtime || lastWaveMtime;

    const fs = Number(data?.fs);
    const n0 = Number(data?.n_original_samples);
    const dur = Number(data?.duration_s);
    waveInfoTextEl.textContent =
      `${Number.isFinite(dur) ? dur.toFixed(1) : "—"}s @ ${Number.isFinite(fs) ? fs.toFixed(0) : "—"}Hz` +
      (Number.isFinite(n0) ? ` • ${n0} samples` : "");

    drawWaveform(Array.isArray(data?.samples) ? data.samples : []);
  } catch {
    waveInfoTextEl.textContent = "waveform unavailable";
  }
}

function connect() {
  if (timer) window.clearInterval(timer);
  timer = null;

  demoMode = false;
  stopAttackMode();

  setStatus("connecting…", "muted");
  setError("");
  setIdle(true);
  lastGoodAt = 0;
  lastBpm = null;

  // Fetch immediately, then poll.
  void fetchFromClaudiacOnce();
  timer = window.setInterval(fetchFromClaudiacOnce, 1200);

  void fetchWaveformOnce(true);
  if (waveTimer) window.clearInterval(waveTimer);
  waveTimer = window.setInterval(fetchWaveformOnce, 1500);
}

connectBtn.addEventListener("click", connect);
baseUrlEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connect();
});

renderDemoButtons();
connect();

waveRefreshBtn.addEventListener("click", () => void fetchWaveformOnce(true));

for (const el of [ecgSourceEl, deviceIdEl]) {
  el.addEventListener("change", () => connect());
}

ecgSourceEl.addEventListener("change", () => {
  // no-op (kept for future source-specific defaults)
});

