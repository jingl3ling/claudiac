"""
WSGI entry for Gunicorn / cloud hosts.

  gunicorn -w 1 -b 0.0.0.0:$PORT wsgi:app

Run with repo root = `claudiac/` (so `algorithms/`, `data/`, `server/` are visible).
"""
from server.app import app  # must run from claudiac root
