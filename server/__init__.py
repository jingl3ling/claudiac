# Makes `server` a package so Gunicorn can use: gunicorn server.app:app
from .app import app  # noqa: F401
