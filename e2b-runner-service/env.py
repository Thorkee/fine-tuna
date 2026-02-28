"""
Shared environment loading for the runner service.

The runner service is often developed alongside a Next.js app that keeps secrets in
.env.local at the repo root. To reduce friction, we load env vars from:
- current working directory (.env via python-dotenv default)
- service directory (.env, .env.local)
- repo root (.env, .env.local)

We never override already-set process environment variables.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv


def load_runner_env() -> None:
    # Load from CWD (.env) first for typical `cd e2b-runner-service && uvicorn ...`
    load_dotenv(override=False)

    service_dir = Path(__file__).resolve().parent
    repo_root = service_dir.parent

    candidates = (
        service_dir / ".env",
        service_dir / ".env.local",
        repo_root / ".env",
        repo_root / ".env.local",
    )
    for p in candidates:
        try:
            if p.is_file():
                load_dotenv(p, override=False)
        except Exception:
            # Best-effort only; missing files are expected in some environments.
            continue

