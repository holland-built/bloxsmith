import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

# Run with: uvicorn backend.main:app --port 8000
# Legacy server.py owns port 8080, Vite dev server owns 5173 - no port conflicts.

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


if os.path.isdir("dist"):
    app.mount("/", StaticFiles(directory="dist", html=True), name="static")
