"""
Supabase client and runner_tasks CRUD.
When SUPABASE_URL + key are set: uses Supabase. Otherwise: local mode (in-memory tasks, no persistence).
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from env import load_runner_env

load_runner_env()

try:
    from supabase import create_client, Client
except ImportError:
    create_client = None  # type: ignore
    Client = None  # type: ignore

# Supabase Python client only accepts JWT-format keys (eyJ...). New dashboard keys use sb_secret_* / sb_publishable_*.
# We patch re.match so create_client() accepts the new format; the REST API accepts both.
_JWT_KEY_REGEX = r"^[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*$"


def _create_supabase_client(url: str, key: str) -> Any:
    """Create Supabase client, allowing both JWT and new sb_* key formats."""
    if key.startswith("sb_secret_") or key.startswith("sb_publishable_"):
        _orig_re_match = re.match
        try:
            def _patched_match(pattern: str, string: str) -> Optional[Any]:
                if pattern == _JWT_KEY_REGEX and string and (string.startswith("sb_secret_") or string.startswith("sb_publishable_")):
                    return re.compile(pattern).match("eyJ.eyJ.x")  # truthy Match for client's check
                return _orig_re_match(pattern, string)
            re.match = _patched_match  # type: ignore[assignment]
            return create_client(url, key)
        finally:
            re.match = _orig_re_match  # type: ignore[assignment]
    return create_client(url, key)

_SUPABASE: Optional[Any] = None
_USE_SUPABASE: Optional[bool] = None
_LOCAL_TASKS: dict[str, dict[str, Any]] = {}

# Truncate stdout/stderr in DB; full logs go to run.log in Storage
STDOUT_STDERR_MAX_LEN = 50_000


def supabase_configured() -> bool:
    """True if SUPABASE_URL and key are set (Supabase is used). False = local mode."""
    return _supabase_configured()


def _supabase_api_url() -> Optional[str]:
    """Return the Supabase API URL (https://xxx.supabase.co). Never use postgresql:// for the client."""
    url = (os.getenv("SUPABASE_URL") or "").strip() or (os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip()
    if not url:
        return None
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        url = (os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip()
    return url if url and (url.startswith("http://") or url.startswith("https://")) else None


def _supabase_key() -> Optional[str]:
    """Return the Supabase key (service role preferred), or None if missing/empty."""
    key = (
        (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        or (os.getenv("SUPABASE_ANON_KEY") or "").strip()
        or (os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY") or "").strip()
    )
    return key or None


def _supabase_configured() -> bool:
    global _USE_SUPABASE
    if _USE_SUPABASE is not None:
        return _USE_SUPABASE
    url = _supabase_api_url()
    key = _supabase_key()
    _USE_SUPABASE = bool(url and key and create_client is not None)
    return _USE_SUPABASE


def get_supabase() -> Client:
    global _SUPABASE
    if not _supabase_configured():
        raise RuntimeError("Supabase not configured (missing API URL or key). Use API URL: https://xxx.supabase.co, not postgresql://.")
    if _SUPABASE is not None:
        return _SUPABASE
    url = _supabase_api_url()
    key = _supabase_key()
    if not url or not key:
        raise RuntimeError("Supabase API URL (https://...) and key required. Do not use SUPABASE_URL=postgresql:// for this service.")
    _SUPABASE = _create_supabase_client(url, key)
    return _SUPABASE


def _truncate(s: Optional[str], max_len: int = STDOUT_STDERR_MAX_LEN) -> Optional[str]:
    if s is None:
        return None
    if len(s) <= max_len:
        return s
    return s[:max_len] + "\n\n...[truncated]..."


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_task(
    *,
    expected_output_name: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    requested_backend: Optional[str] = None,
) -> UUID:
    if _supabase_configured():
        supabase = get_supabase()
        row_data: dict[str, Any] = {"status": "pending"}
        if expected_output_name is not None:
            row_data["expected_output_name"] = expected_output_name
        if timeout_seconds is not None:
            row_data["timeout_seconds"] = timeout_seconds
        if requested_backend is not None:
            row_data["requested_backend"] = requested_backend
        row = supabase.table("runner_tasks").insert(row_data).execute()
        data = row.data
        if not data or len(data) == 0:
            raise RuntimeError("Failed to create runner_tasks row")
        return UUID(data[0]["id"])
    task_id = uuid4()
    _LOCAL_TASKS[str(task_id)] = {
        "id": str(task_id),
        "status": "pending",
        "created_at": _now(),
        "updated_at": _now(),
        "input_csv_key": None,
        "script_key": None,
        "output_model_key": None,
        "run_log_key": None,
        "error_message": None,
        "stdout": None,
        "stderr": None,
        "attempts": 0,
        "expected_output_name": expected_output_name or "model.pkl",
        "timeout_seconds": timeout_seconds,
        "requested_backend": requested_backend or "e2b",
        "execution_backend": None,
        "backend_job_id": None,
        "backend_status": None,
        "output_metadata_key": None,
    }
    return task_id


def get_task(task_id: UUID) -> Optional[dict[str, Any]]:
    if _supabase_configured():
        supabase = get_supabase()
        row = supabase.table("runner_tasks").select("*").eq("id", str(task_id)).execute()
        data = row.data
        if not data or len(data) == 0:
            return None
        return data[0]
    return _LOCAL_TASKS.get(str(task_id))


def update_task(
    task_id: UUID,
    *,
    status: Optional[str] = None,
    input_csv_key: Optional[str] = None,
    script_key: Optional[str] = None,
    output_model_key: Optional[str] = None,
    run_log_key: Optional[str] = None,
    error_message: Optional[str] = None,
    stdout: Optional[str] = None,
    stderr: Optional[str] = None,
    attempts: Optional[int] = None,
    requested_backend: Optional[str] = None,
    execution_backend: Optional[str] = None,
    backend_job_id: Optional[str] = None,
    backend_status: Optional[str] = None,
    output_metadata_key: Optional[str] = None,
) -> None:
    if _supabase_configured():
        supabase = get_supabase()
        payload: dict[str, Any] = {"updated_at": _now()}
        if status is not None:
            payload["status"] = status
        if input_csv_key is not None:
            payload["input_csv_key"] = input_csv_key
        if script_key is not None:
            payload["script_key"] = script_key
        if output_model_key is not None:
            payload["output_model_key"] = output_model_key
        if run_log_key is not None:
            payload["run_log_key"] = run_log_key
        if error_message is not None:
            payload["error_message"] = error_message
        if stdout is not None:
            payload["stdout"] = _truncate(stdout)
        if stderr is not None:
            payload["stderr"] = _truncate(stderr)
        if attempts is not None:
            payload["attempts"] = attempts
        if requested_backend is not None:
            payload["requested_backend"] = requested_backend
        if execution_backend is not None:
            payload["execution_backend"] = execution_backend
        if backend_job_id is not None:
            payload["backend_job_id"] = backend_job_id
        if backend_status is not None:
            payload["backend_status"] = backend_status
        if output_metadata_key is not None:
            payload["output_metadata_key"] = output_metadata_key
        supabase.table("runner_tasks").update(payload).eq("id", str(task_id)).execute()
        return
    t = _LOCAL_TASKS.get(str(task_id))
    if not t:
        return
    t["updated_at"] = _now()
    if status is not None:
        t["status"] = status
    if input_csv_key is not None:
        t["input_csv_key"] = input_csv_key
    if script_key is not None:
        t["script_key"] = script_key
    if output_model_key is not None:
        t["output_model_key"] = output_model_key
    if run_log_key is not None:
        t["run_log_key"] = run_log_key
    if error_message is not None:
        t["error_message"] = error_message
    if stdout is not None:
        t["stdout"] = _truncate(stdout)
    if stderr is not None:
        t["stderr"] = _truncate(stderr)
    if attempts is not None:
        t["attempts"] = attempts
    if requested_backend is not None:
        t["requested_backend"] = requested_backend
    if execution_backend is not None:
        t["execution_backend"] = execution_backend
    if backend_job_id is not None:
        t["backend_job_id"] = backend_job_id
    if backend_status is not None:
        t["backend_status"] = backend_status
    if output_metadata_key is not None:
        t["output_metadata_key"] = output_metadata_key
