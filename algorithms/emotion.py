"""
Physiology-based emotion rules (HR + HRV + ECG “ADC” amplitude / rhythm).
Used by the Claudiac API to drive the heart UI; independent of the older
`mood.py` heuristics.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# `ui_key` must match `claudiac/frontend/main.js` (data-demo, buttons).
EMOTION_UI_KEY: Dict[str, str] = {
    "heart_attack": "heart-attack",
    "anger": "anger",
    "anxiety": "anxiety",
    "fear": "fear",
    "joy": "joy",
    "envy": "envy",
    "disgust": "disgust",
    "embarrassment": "embarrassment",
    "ennui": "ennui",
    "sadness": "sadness",
    "unknown": "unknown",
}

# Unique colors (hex) + labels. Keep in sync with `frontend/main.js` `EMOTION_DEFS`.
EMOTION_STYLES: Dict[str, Dict[str, Any]] = {
    "heart_attack": {
        "label": "Heart Attack",
        "color": "#ff0000",
        "attack_mode": True,
    },
    "anger": {"label": "Anger", "color": "#FF0000", "attack_mode": False},
    "anxiety": {"label": "Anxiety", "color": "#FF8C00", "attack_mode": False},
    "fear": {"label": "Fear", "color": "#8A2BE2", "attack_mode": False},
    "joy": {"label": "Joy", "color": "#FFD700", "attack_mode": False},
    "envy": {"label": "Envy", "color": "#00CED1", "attack_mode": False},
    "disgust": {"label": "Disgust", "color": "#32CD32", "attack_mode": False},
    "embarrassment": {
        "label": "Embarrassment",
        "color": "#FF69B4",
        "attack_mode": False,
    },
    "ennui": {"label": "Ennui", "color": "#3A3B5C", "attack_mode": False},
    "sadness": {"label": "Sadness", "color": "#4169E1", "attack_mode": False},
    "unknown": {"label": "Unknown", "color": "#8e8e93", "attack_mode": False},
}

# uV: typical single-lead mobile ECG — separates “pounding” vs “shallow”
AMP_HIGH_MEDIAN_UV = 650.0
AMP_LOW_MEDIAN_UV = 220.0
# Near-absence of signal
FLATLINE_STD_UV = 18.0
# RR or beat-height instability → “erratic”
ERRATIC_RR_CV = 0.20
ERRATIC_AMP_REL_STD = 0.38


def _finite(x: float, default: float = 0.0) -> float:
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return default
    return float(x)


def _classify_amplitude_and_rhythm(
    ecg: np.ndarray,
    fs: float,
    r_peaks: np.ndarray,
    rr_s: np.ndarray,
) -> Tuple[str, Dict[str, float]]:
    """
    Returns (category, details):
      - flatline | erratic | high | low | normal
    “ADC” proxy: R-peak median absolute deflection; rhythm: RR CV, beat-amp spread.
    """
    details: Dict[str, float] = {}
    if ecg is None or len(ecg) < 8 or fs <= 0:
        return "normal", details

    std_sig = float(np.std(ecg))
    details["ecg_std_uV"] = round(std_sig, 2)
    if std_sig < FLATLINE_STD_UV:
        return "flatline", details

    n_rr = len(rr_s)
    if n_rr >= 2:
        mrr = float(np.mean(rr_s)) + 1e-9
        cv_rr = float(np.std(rr_s) / mrr)
        details["rr_cv"] = round(cv_rr, 4)
        if cv_rr > ERRATIC_RR_CV:
            return "erratic", details
    # Beat-to-beat R height variability
    w = max(1, int(0.04 * fs))
    amps: List[float] = []
    for p in np.asarray(r_peaks, dtype=int):
        lo, hi = max(0, p - w), min(len(ecg), p + w)
        if hi > lo:
            seg = ecg[lo:hi]
            amps.append(float(np.max(np.abs(seg))))
    if len(amps) >= 2:
        ma = float(np.mean(amps)) + 1e-9
        rel = float(np.std(amps) / ma)
        details["beat_amp_rel_std"] = round(rel, 4)
        if rel > ERRATIC_AMP_REL_STD:
            return "erratic", details

    if not amps:
        med = float(np.max(np.abs(ecg)))
    else:
        med = float(np.median(amps))
    details["median_r_uV"] = round(med, 2)
    if med >= AMP_HIGH_MEDIAN_UV:
        return "high", details
    if med <= AMP_LOW_MEDIAN_UV:
        return "low", details
    return "normal", details


def infer_emotion(
    hr_bpm: float,
    hrv_sdnn_ms: float,
    ecg: np.ndarray,
    fs: float,
    r_peaks: np.ndarray,
    rr_intervals_s: np.ndarray,
) -> Dict[str, Any]:
    """
    Apply the rule table (order matters: heart attack first, then HR bands).
    HRV in ms; hr_bpm is the value used for rules (e.g. Health when uploaded).
    """
    hr = _finite(hr_bpm, 0.0)
    hrv = _finite(hrv_sdnn_ms, 0.0) if hrv_sdnn_ms is not None else 0.0

    amp, amp_details = _classify_amplitude_and_rhythm(
        ecg, fs, r_peaks, rr_intervals_s
    )

    def pack(eid: str, reason: str) -> Dict[str, Any]:
        st = EMOTION_STYLES.get(eid, EMOTION_STYLES["unknown"])
        return {
            "id": eid,
            "ui_key": EMOTION_UI_KEY.get(eid, eid.replace("_", "-")),
            "label": st["label"],
            "color": st["color"],
            "attack_mode": st.get("attack_mode", False),
            "reason": reason,
            "inputs": {
                "hr_bpm": round(hr, 1),
                "hrv_sdnn_ms": round(hrv, 1) if np.isfinite(hrv) else None,
                "amplitude": amp,
                **amp_details,
            },
        }

    # 1) Heart attack — medical override (spec: ignores HRV; use extreme HR)
    if hr < 40 or hr > 150:
        return pack(
            "heart_attack",
            "Heart rate in a critical range (<40 or >150 BPM). "
            "Seek care if this reflects how you feel now.",
        )

    if not (np.isfinite(hr) and hr > 0):
        return pack("unknown", "Heart rate is missing or not finite.")

    # 2) Tachycardia band
    if hr > 85:
        if hrv < 30:
            if amp == "high":
                return pack(
                    "anger",
                    "High HR, low HRV, strong beat deflection (pounding).",
                )
            if amp in ("low", "flatline", "erratic"):
                return pack(
                    "anxiety",
                    "High HR, low HRV, shallow, noisy, or irregular deflection—stress without pounding.",
                )
            return pack(
                "anxiety",
                "High HR and suppressed HRV; defaulting toward an anxiety pattern.",
            )
        return pack(
            "fear",
            "Elevated HR with preserved HRV (compensated fight-or-flight).",
        )

    # 3) Normal HR 65–85
    if 65 <= hr <= 85:
        if hrv > 50:
            return pack("joy", "Resting-to-normal HR with high HRV (relaxed, positive).")
        if 30 <= hrv <= 50:
            return pack("envy", "Neutral vitals: normal HR, mid-range HRV (baseline).")
        if hrv < 30:
            if amp in ("high", "normal"):
                return pack(
                    "disgust",
                    "Mild stress without HR spike; high beat strength / rejection pattern.",
                )
            return pack(
                "embarrassment",
                "Mild stress with low-amplitude, withdrawn pattern.",
            )
        return pack("envy", "Normal HR, mid HRV (baseline).")

    # 4) Bradycardia < 65 (and ≥ 40, already handled extremes)
    if hr < 65:
        if hrv > 50:
            return pack("ennui", "Low HR with high HRV (very low energy, almost asleep).")
        return pack("sadness", "Low HR with lower HRV (withdrawal, low energy).")

    return pack("unknown", "Vitals do not map cleanly to the rule set.")


if __name__ == "__main__":
    fs = 256.0
    t = np.arange(0, 30, 1 / fs)
    ecg = 800 * np.sin(2 * np.pi * 1.2 * t) * np.hanning(len(t)) * 1e-3
    r = np.array([i * int(fs) for i in range(1, 35)])
    rr = np.diff(r) / fs
    e = infer_emotion(90, 25, ecg, fs, r, rr)
    print(e["id"], e["reason"][:60])
