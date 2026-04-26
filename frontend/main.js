const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** Must match `AppConfig.deviceId` in the iOS ingest app for upload mode. */
const API_BASE_URL = "https://claudiac-production.up.railway.app";
const UPLOAD_DEVICE_ID = "ios-001";

const connectBtn = /** @type {HTMLButtonElement} */ ($("connectBtn"));
const ecgSourceEl = /** @type {HTMLSelectElement} */ ($("ecgSource"));

const bpmValueEl = $("bpmValue");
const statusTextEl = $("statusText");
const sourceTextEl = $("sourceText");
const emotionTextEl = $("emotionText");
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

// Scrolling ECG (time-correct: matches recording duration, demo vs upload)
const WINDOW_S = 2.0;
let fullSamples = [];
let displaySampleRate = 256;
let playheadStartedAt = 0;
/** @type {number | null} */
let scopeRafId = null;

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

/**
 * Map BPM to a heart accent: cooler / calmer at low rates, warmer at higher rates.
 * Uses HSL so the gradient always reads clearly on the SVG.
 */
function applyHeartThemeFromBpm(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return;
  const x = clamp(bpm, 45, 175);
  // ~240° (blue) at low HR → ~8° (red) at high HR
  const hue = Math.round(240 - (x - 45) * (232 / 130));
  const col = `hsl(${hue} 72% 48%)`;
  const colSoft = `hsl(${hue} 72% 48% / 0.32)`;
  document.documentElement.style.setProperty("--accent", col);
  document.documentElement.style.setProperty("--accentSoft", colSoft);
  stop0.setAttribute("stop-color", "#ffffff");
  stop1.setAttribute("stop-color", col);
  stop2.setAttribute("stop-color", col);
}

/**
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number } | null}
 */
function parseHexRgb(hex) {
  const s = String(hex).trim();
  // Allow "#RRGGBB" or "RRGGBB" from API
  const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m6) {
    const v = m6[1];
    return {
      r: parseInt(v.slice(0, 2), 16),
      g: parseInt(v.slice(2, 4), 16),
      b: parseInt(v.slice(4, 6), 16),
    };
  }
  return null;
}

function setThemeAccent(hex) {
  const h = String(hex).trim();
  if (!h) return;
  document.documentElement.style.setProperty("--accent", h);
  // 8-char #RRGGBBAA is unevenly supported in gradients; use rgba for --accentSoft.
  const rgb = parseHexRgb(h);
  if (rgb) {
    document.documentElement.style.setProperty(
      "--accentSoft",
      `rgba(${rgb.r},${rgb.g},${rgb.b},0.32)`
    );
  } else {
    document.documentElement.style.setProperty("--accentSoft", "rgba(255,45,85,0.32)");
  }

  // Update SVG gradient stops to use the accent color (with a little “chrome” variety).
  stop0.setAttribute("stop-color", "#ffffff");
  stop1.setAttribute("stop-color", h);
  stop2.setAttribute("stop-color", h);
}

/** Live mode: use rules-based emotion from `/api/analyze` (HR + HRV + waveform). */
function applyEmotionFromServer(emo) {
  if (!emo || typeof emo !== "object") return;
  if (emo.attack_mode) {
    document.documentElement.dataset.demo = "heart-attack";
    if (!attackTimer) {
      attackTimer = window.setInterval(() => {
        attackPhase = !attackPhase;
        const c = attackPhase ? "#000000" : "#ff0000";
        stop0.setAttribute("stop-color", c);
        stop1.setAttribute("stop-color", c);
        stop2.setAttribute("stop-color", c);
        document.documentElement.style.setProperty("--accent", "#ff0000");
        document.documentElement.style.setProperty("--accentSoft", "rgba(255,0,0,0.42)");
      }, 180);
    }
    return;
  }
  if (attackTimer) {
    window.clearInterval(attackTimer);
    attackTimer = null;
    attackPhase = false;
  }
  const uiKey =
    typeof emo.ui_key === "string" && emo.ui_key
      ? emo.ui_key
      : typeof emo.id === "string"
        ? emo.id.replace(/_/g, "-")
        : "";
  if (uiKey) document.documentElement.dataset.demo = uiKey;
  if (emo.color) setThemeAccent(emo.color);
}

/**
 * Canonical list: `id` = server `emotion.id` from `algorithms/emotion.py` (ECG / iOS ingest).
 * Labels, colors, and demoBpm follow the same rules table as `EMOTION_STYLES` in Python.
 */
const EMOTION_DEFS = {
  heart_attack: {
    label: "Heart Attack",
    swatch: "#ff0000",
    mode: "attack",
    demoBpm: 170,
  },
  anger: { label: "Anger", swatch: "#FF0000", demoBpm: 96 },
  anxiety: { label: "Anxiety", swatch: "#FF8C00", demoBpm: 100 },
  fear: { label: "Fear", swatch: "#8A2BE2", demoBpm: 92 },
  joy: { label: "Joy", swatch: "#FFD700", demoBpm: 72 },
  envy: { label: "Envy", swatch: "#00CED1", demoBpm: 75 },
  disgust: { label: "Disgust", swatch: "#32CD32", demoBpm: 74 },
  embarrassment: { label: "Embarrassment", swatch: "#FF69B4", demoBpm: 70 },
  ennui: { label: "Ennui", swatch: "#3A3B5C", demoBpm: 55 },
  sadness: { label: "Sadness", swatch: "#4169E1", demoBpm: 58 },
};

const EMOTION_ORDER = [
  "heart_attack",
  "anger",
  "anxiety",
  "fear",
  "joy",
  "envy",
  "disgust",
  "embarrassment",
  "ennui",
  "sadness",
];

const EMOTIONS = EMOTION_ORDER.map((id) => {
  const d = EMOTION_DEFS[id];
  if (!d) throw new Error(`Missing EMOTION_DEFS[${id}]`);
  return {
    id,
    key: id === "heart_attack" ? "heart-attack" : id,
    label: d.label,
    swatch: d.swatch,
    mode: d.mode,
    demoBpm: d.demoBpm,
  };
});

function stopScopeAnimation() {
  if (scopeRafId !== null) cancelAnimationFrame(scopeRafId);
  scopeRafId = null;
}

function startScopeAnimation() {
  if (scopeRafId !== null) return;
  playheadStartedAt = performance.now();
  const tick = (now) => {
    drawScrollingScope(now);
    scopeRafId = requestAnimationFrame(tick);
  };
  scopeRafId = requestAnimationFrame(tick);
}

function drawScrollingScope(nowMs) {
  const ctx = waveCanvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = waveCanvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (waveCanvas.width !== w) waveCanvas.width = w;
  if (waveCanvas.height !== h) waveCanvas.height = h;

  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const x = Math.round((w * i) / 10) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let i = 1; i < 6; i++) {
    const y = Math.round((h * i) / 6) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  if (!fullSamples.length) return;

  const totalSeconds = fullSamples.length / displaySampleRate;
  const elapsedMs = nowMs - playheadStartedAt;
  const elapsedS = (elapsedMs / 1000) % Math.max(totalSeconds, 0.001);
  const playheadIdx = Math.floor(elapsedS * displaySampleRate);

  const windowSamples = Math.max(2, Math.floor(WINDOW_S * displaySampleRate));
  const startIdx = playheadIdx - windowSamples;

  const visible = new Array(windowSamples);
  for (let i = 0; i < windowSamples; i++) {
    let idx = startIdx + i;
    while (idx < 0) idx += fullSamples.length;
    while (idx >= fullSamples.length) idx -= fullSamples.length;
    visible[i] = fullSamples[idx];
  }

  let minV = Infinity;
  let maxV = -Infinity;
  for (const v of visible) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
    minV = -1;
    maxV = 1;
  }
  const span = Math.max(maxV - minV, 200);
  const center = (maxV + minV) / 2;
  minV = center - span / 2;
  maxV = center + span / 2;
  const pad = (maxV - minV) * 0.1;
  minV -= pad;
  maxV += pad;

  const accent =
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff2d55";
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1.5, Math.round(1.8 * dpr));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const n = visible.length;
  const xScale = (w - 2) / Math.max(1, n - 1);
  const yScale = (h - 2) / (maxV - minV);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = 1 + i * xScale;
    const y = 1 + (maxV - visible[i]) * yScale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/**
 * @param {Record<string, unknown>} ecgPayload — shape from /api/analyze `ecg` or /api/waveform
 */
function adoptWaveformFromEcgPayload(ecgPayload) {
  const samples = ecgPayload?.samples_uV;
  if (!Array.isArray(samples) || !samples.length) {
    fullSamples = [];
    stopScopeAnimation();
    return;
  }
  const fs = Number(ecgPayload.sampling_rate);
  const step = Number(ecgPayload.display_step) || 1;
  const dur = Number(ecgPayload.duration_s);
  const n0 = Number(ecgPayload.n_original_samples);
  const n = samples.length;

  fullSamples = /** @type {number[]} */ (samples);
  if (Number.isFinite(dur) && dur > 0 && n > 0) {
    displaySampleRate = n / dur;
  } else {
    const fs0 = Number.isFinite(fs) && fs > 0 ? fs : 256;
    displaySampleRate = fs0 / (step > 0 ? step : 1);
  }

  playheadStartedAt = performance.now();
  waveInfoTextEl.textContent =
    `${Number.isFinite(dur) ? dur.toFixed(1) : "—"}s @ ${Number.isFinite(fs) ? fs.toFixed(0) : "—"}Hz` +
    (Number.isFinite(n0) ? ` • ${n0} samples` : "") +
    ` • scope ${WINDOW_S}s`;

  startScopeAnimation();
}

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
  stopScopeAnimation();
  fullSamples = [];

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

    applyBpm(
      typeof emo.demoBpm === "number" && emo.demoBpm > 0 ? emo.demoBpm : 170,
      "demo: Heart Attack"
    );
    return;
  }

  stopAttackMode();
  document.documentElement.dataset.demo = emo.key;
  setThemeAccent(emo.swatch);
  const bpm = typeof emo.demoBpm === "number" && emo.demoBpm > 0 ? emo.demoBpm : 72;
  applyBpm(bpm, `demo: ${emo.label}`);
}

async function fetchFromClaudiacOnce() {
  // If the user picked a demo, keep it running until they hit Connect.
  if (demoMode) return;

  const baseUrl = API_BASE_URL.replace(/\/+$/, "");
  const source = ecgSourceEl.value;
  const deviceId = UPLOAD_DEVICE_ID;
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

    setError("");

    const emo = data?.emotion;
    if (emo?.label) {
      emotionTextEl.textContent = emo.label;
    } else {
      emotionTextEl.textContent = "—";
    }

    if (Number.isFinite(bpm) && bpm > 0) {
      if (emo?.color) {
        applyEmotionFromServer(emo);
      } else {
        applyHeartThemeFromBpm(bpm);
      }
      if (data?.ecg) {
        adoptWaveformFromEcgPayload(/** @type {Record<string, unknown>} */ (data.ecg));
      }
      setStatus("connected", "ok");
      applyBpm(bpm, `/api/analyze?source=${source}${source === "upload" ? `&deviceId=${encodeURIComponent(deviceId)}` : ""}`);
      lastBpm = bpm;
      lastGoodAt = Date.now();
      return;
    }

    if (emo?.color) {
      applyEmotionFromServer(emo);
    } else {
      document.documentElement.dataset.demo = "";
    }
    if (data?.ecg) {
      adoptWaveformFromEcgPayload(/** @type {Record<string, unknown>} */ (data.ecg));
    }
    bpmValueEl.textContent = "—";
    sourceTextEl.textContent = "connected (no bpm yet)";
    if (!emo?.label) emotionTextEl.textContent = "—";
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

async function fetchWaveformOnce(force = false) {
  if (demoMode) return;
  const baseUrl = API_BASE_URL.replace(/\/+$/, "");
  const source = ecgSourceEl.value;
  const deviceId = UPLOAD_DEVICE_ID;

  try {
    const waveUrl = new URL(`${baseUrl}/api/waveform`);
    waveUrl.searchParams.set("source", source);
    if (source === "upload") waveUrl.searchParams.set("deviceId", deviceId);

    const res = await fetch(waveUrl.toString(), { cache: "no-store" });
    if (!res.ok) {
      if (res.status === 404) {
        waveInfoTextEl.textContent = "no live capture yet";
        fullSamples = [];
        return;
      }
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const mtime = Number(data?.mtime ?? 0);
    if (!force && mtime && mtime === lastWaveMtime) return;
    lastWaveMtime = mtime || lastWaveMtime;

    adoptWaveformFromEcgPayload({
      samples_uV: data?.samples,
      sampling_rate: data?.fs,
      display_step: data?.display_step,
      duration_s: data?.duration_s,
      n_original_samples: data?.n_original_samples,
    });
  } catch {
    waveInfoTextEl.textContent = "waveform unavailable";
  }
}

function connect() {
  if (timer) window.clearInterval(timer);
  timer = null;

  demoMode = false;
  stopAttackMode();
  stopScopeAnimation();

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

renderDemoButtons();
connect();

waveRefreshBtn.addEventListener("click", () => void fetchWaveformOnce(true));

ecgSourceEl.addEventListener("change", () => connect());

