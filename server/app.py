"""
Claudiac Flask backend.

Exposes the algorithms layer as HTTP endpoints so the frontend
(HTML/JS, written by the teammate) can call them via fetch().

Endpoints:
  GET  /                  -> health check (returns {"status": "ok"})
  GET  /api/analyze       -> runs the full pipeline on the bundled ECG
                             and returns ECG samples + R-peaks + HR/HRV
                             + mood + risk
  POST /api/mood          -> re-runs only the mood inference with a
                             custom self-report (so the UI can let the
                             user change valence/arousal and re-infer)

Run from the project root:
    python server\app.py

Then open http://localhost:5000/api/analyze in a browser to see the JSON,
or have the frontend fetch from the same URL.
"""

import os
import sys
import json
import math
import numpy as np
from typing import Optional
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import time

# Make `algorithms` importable when running from the project root
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from algorithms.heart_rate import pan_tompkins
from algorithms.mood import infer_mood, MOCK_SELF_REPORT, MOCK_CONTEXT
from algorithms.risk import compute_risk


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
FRONTEND_DIR = os.path.join(ROOT, "frontend")
app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app)  # allow the frontend to call us from any origin


# ---------------------------------------------------------------------------
# Cache: load ECG once at startup, reuse on every request
# ---------------------------------------------------------------------------
def _load_ecg() -> dict:
    """
    Demo ECG for `source=demo`. Prefer compact `.npz`; fall back to JSON in repo
    (cloud deploys often omit large binaries). Last resort: tiny synthetic signal.
    """
    data_dir = os.path.join(ROOT, "data")
    npz_path = os.path.join(data_dir, "apple_watch_ecg_api.npz")
    json_path = os.path.join(data_dir, "apple_watch_ecg_api.json")

    if os.path.exists(npz_path):
        d = np.load(npz_path)
        return {
            "voltage_uV": d["voltage_uV"].astype(float),
            "sampling_rate": float(d["sampling_rate"]),
        }

    if os.path.exists(json_path):
        with open(json_path, "r", encoding="utf-8") as f:
            blob = json.load(f)
        fs = float(blob["samplingFrequency"]["value"])
        v = blob["voltageMeasurements"]["voltage_uV"]
        return {
            "voltage_uV": np.asarray(v, dtype=float),
            "sampling_rate": fs,
        }

    # Minimal fallback so the process still starts (e.g. misconfigured deploy).
    # Not clinically meaningful — use iOS upload for real ECGs.
    fs = 256.0
    n = int(20 * fs)
    t = np.arange(n) / fs
    rng = np.random.default_rng(0)
    sig = 300.0 * np.sin(2 * np.pi * 1.05 * t) + 20.0 * rng.standard_normal(n)
    return {"voltage_uV": sig.astype(float), "sampling_rate": fs}


ECG = _load_ecg()

API_KEY = os.environ.get("API_KEY", "").strip()

def _require_api_key(req) -> bool:
    if not API_KEY:
        return True
    provided = (req.headers.get("x-api-key") or "").strip()
    return provided == API_KEY

# Latest uploaded ECGs (e.g. from iOS ECGIngest). Stored in-memory.
# Shape: { deviceId: { "ts": str, "fs": float, "samples_uV": np.ndarray, "received_at": float } }
UPLOADED_ECG = {}

def _load_live_ecg_if_present():
    """
    Read the latest DAQ capture saved by `daq.py` (data/live_ecg.npz).
    This file is written when the user presses 's' in the DAQ window.
    """
    live_path = os.path.join(ROOT, "data", "live_ecg.npz")
    if not os.path.exists(live_path):
        return None

    try:
        d = np.load(live_path)
    except Exception:
        # File may be partially written/corrupted; treat as missing for the UI.
        return None
    # Prefer normalized for display (more stable y-range), but keep raw if needed later.
    ecg = d["ecg"].astype(float) if "ecg" in d.files else d["ecg_raw"].astype(float)
    fs = float(d["fs"]) if "fs" in d.files else float(ECG["sampling_rate"])
    mtime = os.path.getmtime(live_path)
    return {"ecg": ecg, "fs": fs, "mtime": mtime, "path": live_path}

def _get_ecg_source(source: str, device_id: Optional[str]):
    """
    Returns (signal_uV: np.ndarray, fs: float, meta: dict) or (None, None, meta) when missing.
    source: "demo" | "daq" | "upload"
    """
    source = (source or "demo").strip().lower()

    if source == "upload":
        did = (device_id or "").strip()
        if not did:
            return None, None, {"source": "upload", "error": "missing_deviceId"}
        item = UPLOADED_ECG.get(did)
        if not item:
            return None, None, {"source": "upload", "error": "not_found", "deviceId": did}
        return item["samples_uV"], item["fs"], {
            "source": "upload",
            "deviceId": did,
            "ts": item.get("ts"),
            "received_at": item.get("received_at"),
        }

    if source == "daq":
        live = _load_live_ecg_if_present()
        if not live:
            return None, None, {"source": "daq", "error": "not_found"}
        return live["ecg"], live["fs"], {"source": "daq", "mtime": live["mtime"]}

    # default: demo bundle
    return ECG["voltage_uV"], ECG["sampling_rate"], {"source": "demo"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _downsample_for_display(signal: np.ndarray, target_points: int = 1500
                            ) -> list:
    """
    The raw ECG has 15,360 samples. Sending all of them to the browser
    works but bloats payload. Downsample for plotting only — actual
    R-peak detection runs on the full signal server-side.
    """
    if len(signal) <= target_points:
        return signal.tolist()
    step = max(1, len(signal) // target_points)
    return signal[::step].tolist()

def _json_sanitize(value):
    """
    Make responses JSON-strict. numpy / Python can emit `NaN` / `Inf`, which
    are not valid JSON and break `fetch().json()`.
    """
    if value is None:
        return None
    if isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        return None
    if isinstance(value, (np.floating,)):
        x = float(value)
        if math.isfinite(x):
            return x
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, np.ndarray):
        return _json_sanitize(value.tolist())
    if isinstance(value, dict):
        return {str(k): _json_sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_sanitize(v) for v in value]
    return value


def _run_full_pipeline(ecg: np.ndarray,
                       fs: float,
                       self_report: dict = None,
                       context: dict = None) -> dict:
    """Run heart_rate -> mood -> risk and return everything in one bundle."""
    hr_result = pan_tompkins(ecg, fs)
    mood = infer_mood(hr_result["heart_rate_bpm"],
                      hr_result["hrv_sdnn_ms"],
                      self_report=self_report,
                      context=context)
    risk = compute_risk(hr_result["heart_rate_bpm"],
                        hr_result["hrv_sdnn_ms"],
                        hr_result["rr_intervals_s"])

    # Convert ndarray -> list for JSON, downsample ECG for plotting
    ecg_display = _downsample_for_display(ecg, target_points=1500)
    display_step = max(1, len(ecg) // len(ecg_display))
    # R-peak indices need to map onto the downsampled x-axis
    r_peaks_display = (hr_result["r_peaks"] // display_step).tolist()

    return {
        "ecg": {
            "samples_uV": ecg_display,
            "sampling_rate": fs,
            "duration_s": len(ecg) / fs,
            "n_original_samples": int(len(ecg)),
            "display_step": int(display_step),
        },
        "r_peaks_display": r_peaks_display,
        "heart_rate": {
            "bpm": round(hr_result["heart_rate_bpm"], 1),
            "hrv_sdnn_ms": round(hr_result["hrv_sdnn_ms"], 1),
            "n_beats": int(len(hr_result["r_peaks"])),
        },
        "mood": mood,
        "risk": risk,
        "self_report": self_report or MOCK_SELF_REPORT,
        "context": context or MOCK_CONTEXT,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "claudiac-backend"})


@app.route("/api/analyze", methods=["GET"])
def analyze():
    """
    Full pipeline run.

    Query params:
      - source: demo | daq | upload
      - deviceId: required when source=upload
    """
    source = str(request.args.get("source", "demo"))
    device_id = request.args.get("deviceId")
    sig, fs, meta = _get_ecg_source(source, device_id)
    if sig is None:
        return jsonify({"error": meta.get("error", "not_found"), "meta": meta}), 404

    out = _run_full_pipeline(sig, fs)
    out["meta"] = meta
    return jsonify(_json_sanitize(out))

@app.route("/api/ecg", methods=["POST"])
def upload_ecg():
    """
    Upload ECG waveform (e.g. from iOS ECGIngest).
    Body:
      { deviceId, ts, samplingHz, voltages: [microvolts...] }
    """
    if not _require_api_key(request):
        return jsonify({"error": "unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    device_id = str(body.get("deviceId", "")).strip()
    ts = str(body.get("ts", "")).strip()
    fs = body.get("samplingHz", None)
    voltages = body.get("voltages", None)

    if not device_id or not ts or not isinstance(fs, (int, float)) or not isinstance(voltages, list):
        return jsonify({"error": "invalid_body"}), 400
    if fs <= 0 or fs > 100_000:
        return jsonify({"error": "invalid_samplingHz"}), 400
    if len(voltages) < 10 or len(voltages) > 200_000:
        return jsonify({"error": "invalid_voltages_length"}), 400

    try:
        arr = np.array(voltages, dtype=float)
    except Exception:
        return jsonify({"error": "invalid_voltages"}), 400

    UPLOADED_ECG[device_id] = {
        "ts": ts,
        "fs": float(fs),
        "samples_uV": arr,
        "received_at": time.time(),
    }
    return jsonify({"ok": True})

@app.route("/api/ecg/latest", methods=["GET"])
def get_latest_ecg():
    if not _require_api_key(request):
        return jsonify({"error": "unauthorized"}), 401

    device_id = str(request.args.get("deviceId", "")).strip()
    if not device_id:
        return jsonify({"error": "missing_deviceId"}), 400

    item = UPLOADED_ECG.get(device_id)
    if not item:
        return jsonify({"error": "not_found"}), 404

    sig = item["samples_uV"]
    fs = item["fs"]
    samples = _downsample_for_display(sig, target_points=1600)
    return jsonify(_json_sanitize({
        "deviceId": device_id,
        "ts": item.get("ts"),
        "fs": fs,
        "samples": samples,
        "n_original_samples": int(len(sig)),
        "duration_s": float(len(sig) / fs) if fs else None,
        "received_at": float(item.get("received_at") or 0),
    }))

@app.route("/api/waveform", methods=["GET"])
def waveform():
    """
    Unified waveform endpoint for the UI.
    Query params:
      - source: demo | daq | upload
      - deviceId: required when source=upload
    """
    source = str(request.args.get("source", "demo"))
    device_id = request.args.get("deviceId")
    sig, fs, meta = _get_ecg_source(source, device_id)
    if sig is None:
        return jsonify({"error": meta.get("error", "not_found"), "meta": meta}), 404

    samples = _downsample_for_display(sig, target_points=1600)
    return jsonify(_json_sanitize({
        "fs": fs,
        "samples": samples,
        "n_original_samples": int(len(sig)),
        "duration_s": float(len(sig) / fs) if fs else None,
        "meta": meta,
        "mtime": meta.get("mtime"),
        "received_at": meta.get("received_at"),
    }))

@app.route("/api/waveform/live", methods=["GET"])
def live_waveform():
    """
    Returns the most recently saved DAQ waveform (from `daq.py`).

    Response:
      { "fs": number, "samples": number[], "n_original_samples": number, "duration_s": number, "mtime": number }
    """
    live = _load_live_ecg_if_present()
    if not live:
        return jsonify({"error": "not_found", "hint": "Run daq.py and press 's' to save data/live_ecg.npz"}), 404

    sig = live["ecg"]
    fs = live["fs"]
    samples = _downsample_for_display(sig, target_points=1600)
    return jsonify(_json_sanitize({
        "fs": fs,
        "samples": samples,
        "n_original_samples": int(len(sig)),
        "duration_s": float(len(sig) / fs) if fs else None,
        "mtime": float(live["mtime"]),
    }))


@app.route("/api/mood", methods=["POST"])
def mood_only():
    """
    Re-infer mood with a custom self-report from the UI.
    Body (JSON): {"valence": "stressed", "arousal": "high", "note": "..."}
    """
    body = request.get_json(silent=True) or {}
    self_report = {
        "valence": body.get("valence", "calm"),
        "arousal": body.get("arousal", "low"),
        "note": body.get("note", ""),
    }
    # Respect the same ECG selection as /api/analyze.
    source = str(request.args.get("source", "demo"))
    device_id = request.args.get("deviceId")
    sig, fs, meta = _get_ecg_source(source, device_id)
    if sig is None:
        return jsonify({"error": meta.get("error", "not_found"), "meta": meta}), 404

    out = _run_full_pipeline(sig, fs, self_report=self_report)
    out["meta"] = meta
    return jsonify(_json_sanitize(out))


# Optional: serve the frontend on the same port (avoids CORS entirely)
@app.route("/")
def index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return send_from_directory(FRONTEND_DIR, "index.html")
    return jsonify({
        "status": "ok",
        "message": "Claudiac backend is running. Frontend not yet built.",
        "try": ["/api/health", "/api/analyze"],
    })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 60)
    print("  Claudiac backend")
    print("=" * 60)
    print(f"  Project root : {ROOT}")
    print(f"  Frontend dir : {FRONTEND_DIR}")
    print(f"  ECG samples  : {len(ECG['voltage_uV']):,} @ "
          f"{ECG['sampling_rate']:.0f} Hz")
    print()
    print("  Endpoints:")
    print("    GET  http://localhost:5000/api/health")
    print("    GET  http://localhost:5000/api/analyze")
    print("    POST http://localhost:5000/api/mood")
    print("=" * 60)
    port = int(os.environ.get("PORT", "5100"))
    app.run(host="0.0.0.0", port=port, debug=False)
