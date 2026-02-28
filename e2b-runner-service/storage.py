"""
Supabase Storage client for runner-artifacts bucket.
When Supabase is configured: uses bucket. Otherwise: local mode (files under LOCAL_BUCKET_DIR).
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Optional
from uuid import UUID

from env import load_runner_env

load_runner_env()

BUCKET = "runner-artifacts"
_LOCAL_BUCKET_DIR: Optional[Path] = None


def _supabase_api_url() -> Optional[str]:
    url = (os.getenv("SUPABASE_URL") or "").strip() or (os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip()
    if not url:
        return None
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        url = (os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip()
    return url if url and (url.startswith("http://") or url.startswith("https://")) else None


def _use_local_storage() -> bool:
    url = _supabase_api_url()
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    return not (url and key)


def _local_bucket_dir() -> Path:
    global _LOCAL_BUCKET_DIR
    if _LOCAL_BUCKET_DIR is None:
        base = os.getenv("RUNNER_TEMP_DIR", tempfile.gettempdir())
        _LOCAL_BUCKET_DIR = Path(base) / "e2b-runner" / "runner-artifacts"
    return _LOCAL_BUCKET_DIR


def _local_path(key: str) -> Path:
    return _local_bucket_dir() / key


def _get_supabase():
    from db import get_supabase
    return get_supabase()


# Storage key layout: inputs/<task_id>/ and outputs/<task_id>/
def input_csv_key(task_id: UUID) -> str:
    return f"inputs/{task_id}/input.csv"


def input_file_key(task_id: UUID, filename: str) -> str:
    safe = str(filename or "input").strip().replace("/", "_")
    return f"inputs/{task_id}/{safe or 'input'}"


def input_script_key(task_id: UUID) -> str:
    return f"inputs/{task_id}/train.py"


def output_model_key(task_id: UUID, filename: str = "model.pkl") -> str:
    return f"outputs/{task_id}/{filename}"


def output_run_log_key(task_id: UUID) -> str:
    return f"outputs/{task_id}/run.log"


def output_metadata_key(task_id: UUID) -> str:
    return f"outputs/{task_id}/metadata.json"


def upload_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    if _use_local_storage():
        p = _local_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return
    supabase = _get_supabase()
    try:
        supabase.storage.from_(BUCKET).upload(key, data, file_options={"content-type": content_type, "upsert": "true"})
    except TypeError:
        supabase.storage.from_(BUCKET).upload(key, data)


def upload_file(key: str, local_path: str | Path, content_type: Optional[str] = None) -> None:
    path = Path(local_path)
    if not path.is_file():
        raise FileNotFoundError(local_path)
    with open(path, "rb") as f:
        data = f.read()
    if content_type is None:
        if path.suffix == ".csv":
            content_type = "text/csv"
        elif path.suffix == ".py":
            content_type = "text/x-python"
        elif path.suffix == ".json":
            content_type = "application/json"
        elif path.suffix == ".log":
            content_type = "text/plain"
        else:
            content_type = "application/octet-stream"
    upload_bytes(key, data, content_type)


def download_to_path(key: str, local_path: str | Path) -> None:
    if _use_local_storage():
        src = _local_path(key)
        if not src.is_file():
            raise FileNotFoundError(key)
        dest = Path(local_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        return
    supabase = _get_supabase()
    data = supabase.storage.from_(BUCKET).download(key)
    Path(local_path).parent.mkdir(parents=True, exist_ok=True)
    with open(local_path, "wb") as f:
        f.write(data)


def download_bytes(key: str) -> bytes:
    if _use_local_storage():
        p = _local_path(key)
        if not p.is_file():
            raise FileNotFoundError(key)
        return p.read_bytes()
    supabase = _get_supabase()
    return supabase.storage.from_(BUCKET).download(key)


def create_signed_url(key: str, expires_in: int = 3600) -> str:
    supabase = _get_supabase()
    result = supabase.storage.from_(BUCKET).create_signed_url(key, expires_in)
    if isinstance(result, dict) and "signedURL" in result:
        return result["signedURL"]
    if hasattr(result, "signed_url"):
        return result.signed_url
    return str(result)


def get_public_url(key: str) -> str:
    supabase = _get_supabase()
    return supabase.storage.from_(BUCKET).get_public_url(key)
