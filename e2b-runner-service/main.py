"""
Tuna Runner Service — FastAPI app.
- POST /tasks = multipart only (form fields csv, script).
- POST /tasks/by-reference = JSON (recommended for agents; csv_url+script_url or csv_key+script_key).
- GET /tasks/{id}/status, GET /tasks/{id}/output, /output/log, /output/metadata.
Status in Supabase Postgres; inputs/outputs in Supabase Storage (bucket runner-artifacts).
"""
from __future__ import annotations

import json
import os
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional, List, Literal

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile, Request, Depends
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

# Load env (service .env/.env.local + repo root .env/.env.local)
from env import load_runner_env

load_runner_env()

from db import create_task, get_task, update_task, supabase_configured
from runner import (
    E2BModelRunnerError,
    run_training_in_e2b,
    build_kaggle_dataset_download_command,
    build_kaggle_dataset_upload_command,
    build_kaggle_competition_submit_command,
    build_kaggle_kernel_push_command,
)
from sagemaker_executor import SageMakerExecutionError, run_training_in_sagemaker
from wandb_runtime import finish_wandb_run, log_wandb_status, start_wandb_run, wandb_state_to_metadata
from sessions import (
    session_manager,
    exec_command,
    start_command,
    command_status,
    command_send_stdin,
    command_kill,
    create_pty,
    pty_status,
    pty_send,
    pty_resize,
    pty_kill,
    write_files,
    list_files,
    read_file,
    run_browser_action,
)
from desktop_sessions import (
    desktop_session_manager,
    run_actions as desktop_run_actions,
    take_screenshot as desktop_take_screenshot,
    start_stream as desktop_start_stream,
    get_stream_url as desktop_get_stream_url,
    stop_stream as desktop_stop_stream,
    get_recording_payload as desktop_get_recording_payload,
)
from storage import (
    download_to_path,
    input_file_key,
    input_script_key,
    output_metadata_key,
    output_model_key,
    output_run_log_key,
    upload_file,
    upload_bytes,
    download_bytes,
)

app = FastAPI(
    title="E2B Runner Service",
    description="POST /tasks = multipart only. POST /tasks/by-reference = JSON (recommended for agents). Submit input + script, run in selected backend (E2B/SageMaker), get outputs from Storage.",
)

TEMP_DIR = Path(os.getenv("RUNNER_TEMP_DIR", tempfile.gettempdir())) / "e2b-runner"
TEMP_DIR.mkdir(parents=True, exist_ok=True)

_executor = ThreadPoolExecutor(max_workers=4)

# Truncation for DB (full logs in run.log)
STDOUT_STDERR_MAX = 50_000


def _parse_int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except Exception:
        return default
    return value if value > 0 else default


def _normalize_session_workdir(raw: Optional[str]) -> str:
    value = (raw or "").strip().replace("\\", "/")
    if not value:
        return "/code"
    parts = [part for part in value.split("/") if part and part != "."]
    if any(part == ".." for part in parts):
        raise HTTPException(status_code=400, detail="workdir cannot include '..'")
    if value.startswith("/"):
        return f"/{'/'.join(parts)}" if parts else "/"
    if not parts:
        return "/code"
    return f"/code/{'/'.join(parts)}"


def _session_error_status(message: str, default: int = 400) -> int:
    lower = message.lower()
    if "not found" in lower or "does not exist" in lower:
        return 404
    if "expired" in lower:
        return 410
    if "timeout" in lower:
        return 504
    return default


def _require_auth(request: Request) -> None:
    token = (os.getenv("RUNNER_AUTH_TOKEN") or "").strip()
    if not token:
        return
    header = request.headers.get("authorization") or request.headers.get("x-runner-token") or ""
    provided = header
    if header.lower().startswith("bearer "):
        provided = header.split(" ", 1)[1].strip()
    if not provided or provided != token:
        raise HTTPException(status_code=401, detail="Unauthorized")


def _run_task(
    task_id: uuid.UUID,
    input_path: str,
    script_path: str,
    input_name: str,
    expected_output_name: str = "model.pkl",
    extra_inputs: Optional[List[tuple[str, str]]] = None,
    hf_models: Optional[List[dict[str, Any]]] = None,
    hf_datasets: Optional[List[dict[str, Any]]] = None,
    github_repos: Optional[List[dict[str, Any]]] = None,
    hf_token: Optional[str] = None,
    github_token: Optional[str] = None,
    kaggle_datasets: Optional[List[dict[str, Any]]] = None,
    kaggle_token: Optional[str] = None,
    backend: Optional[str] = "e2b",
    sagemaker: Optional[dict[str, Any]] = None,
    wandb: Optional[dict[str, Any]] = None,
) -> None:
    """Run training in background; upload results; update DB with backend/runtime metadata."""
    requested_backend = (backend or "e2b").strip().lower()
    if requested_backend not in {"e2b", "sagemaker"}:
        requested_backend = "e2b"

    execution_backend = "sagemaker" if requested_backend == "sagemaker" else "e2b"
    backend_job_id: Optional[str] = None
    backend_status = "running"
    wandb_state = None

    try:
        update_task(
            task_id,
            status="running",
            requested_backend=requested_backend,
            execution_backend=execution_backend,
            backend_status=backend_status,
        )
        wandb_state = start_wandb_run(
            task_id=task_id,
            requested_backend=requested_backend,
            execution_backend=execution_backend,
            wandb_config=wandb,
        )
        out_dir = TEMP_DIR / str(task_id) / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        timeout_hint: Optional[int] = None
        try:
            row = get_task(task_id)
            raw_timeout = row.get("timeout_seconds") if isinstance(row, dict) else None
            if raw_timeout is not None:
                timeout_hint = int(raw_timeout)
        except Exception:
            timeout_hint = None

        attempts = 0
        stdout_text = ""
        stderr_text = ""
        produced_files: List[str] = []
        applied_patches_count = 0
        model_path: Optional[str] = None
        sagemaker_runtime: Optional[dict[str, Any]] = None

        if requested_backend == "sagemaker":
            execution_backend = "sagemaker"
            update_task(task_id, execution_backend=execution_backend, backend_status="submitting")
            log_wandb_status(wandb_state, "submitting", {"execution_backend": execution_backend})

            def _on_sagemaker_status(status: str, secondary: Optional[str]) -> None:
                status_text = status if not secondary else f"{status}:{secondary}"
                update_task(task_id, backend_status=status_text, execution_backend="sagemaker")
                log_wandb_status(wandb_state, status.lower(), {"secondary_status": secondary or ""})

            sm_result = run_training_in_sagemaker(
                task_id=task_id,
                input_path=input_path,
                script_path=script_path,
                input_name=input_name,
                expected_model_filename=expected_output_name,
                local_output_dir=str(out_dir),
                extra_inputs=extra_inputs,
                sagemaker_config=sagemaker,
                wandb_config=wandb,
                hf_models=hf_models,
                hf_datasets=hf_datasets,
                hf_token=hf_token,
                timeout_seconds=timeout_hint,
                on_status_update=_on_sagemaker_status,
            )
            attempts = sm_result.attempts
            stdout_text = sm_result.stdout
            stderr_text = sm_result.stderr
            produced_files = sm_result.produced_files
            model_path = sm_result.model_local_path
            backend_job_id = sm_result.training_job_name
            sagemaker_runtime = {
                **(sagemaker or {}),
                "training_job_name": sm_result.training_job_name,
                "final_status": sm_result.final_status,
                "output_s3_uri": sm_result.output_s3_uri,
                "model_artifact_s3_uri": sm_result.model_artifact_s3_uri,
                "summary": sm_result.summary,
            }
        else:
            execution_backend = "e2b"
            update_task(task_id, execution_backend=execution_backend, backend_status="running")
            log_wandb_status(wandb_state, "running", {"execution_backend": execution_backend})
            result = run_training_in_e2b(
                input_path=input_path,
                script_path=script_path,
                input_name=input_name,
                expected_model_filename=expected_output_name,
                sandbox_workdir="/code",
                timeout_seconds=timeout_hint,
                extra_args=None,
                max_attempts=3,
                use_openai_autofix=True,
                local_output_dir=str(out_dir),
                extra_inputs=extra_inputs,
                hf_models=hf_models,
                hf_datasets=hf_datasets,
                github_repos=github_repos,
                hf_token=hf_token,
                github_token=github_token,
                kaggle_datasets=kaggle_datasets,
                kaggle_token=kaggle_token,
            )
            attempts = result.attempts
            stdout_text = result.stdout
            stderr_text = result.stderr
            produced_files = result.produced_files
            model_path = result.model_local_path
            applied_patches_count = len(result.applied_patches)
            log_wandb_status(
                wandb_state,
                "running",
                {
                    "attempts": result.attempts,
                    "produced_files": len(result.produced_files or []),
                },
            )

        full_log = f"STDOUT:\n{stdout_text}\n\nSTDERR:\n{stderr_text}"
        run_log_path = out_dir / "run.log"
        with open(run_log_path, "w", encoding="utf-8") as f:
            f.write(full_log)

        metadata = {
            "task_id": str(task_id),
            "status": "completed",
            "attempts": attempts,
            "model_local_path": model_path,
            "produced_files": produced_files,
            "applied_patches_count": applied_patches_count,
            "requested_backend": requested_backend,
            "execution_backend": execution_backend,
            "backend_job_id": backend_job_id,
            "sagemaker": sagemaker_runtime if execution_backend == "sagemaker" else (sagemaker or None),
            "wandb": None,
        }
        wandb_state = finish_wandb_run(
            wandb_state,
            success=True,
            summary={
                "attempts": attempts,
                "requested_backend": requested_backend,
                "execution_backend": execution_backend,
                "backend_job_id": backend_job_id,
            },
        )
        metadata["wandb"] = wandb_state_to_metadata(wandb_state, wandb)
        metadata_path = out_dir / "metadata.json"
        with open(metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)

        if not model_path or not os.path.isfile(model_path):
            raise E2BModelRunnerError("No model file produced")

        output_model_storage_key = output_model_key(task_id, os.path.basename(model_path))
        output_log_storage_key = output_run_log_key(task_id)
        output_metadata_storage_key = output_metadata_key(task_id)
        upload_file(output_model_storage_key, model_path)
        upload_file(output_log_storage_key, run_log_path, content_type="text/plain")
        upload_file(output_metadata_storage_key, metadata_path, content_type="application/json")
        update_task(
            task_id,
            status="completed",
            output_model_key=output_model_storage_key,
            run_log_key=output_log_storage_key,
            stdout=stdout_text,
            stderr=stderr_text,
            attempts=attempts,
            requested_backend=requested_backend,
            execution_backend=execution_backend,
            backend_job_id=backend_job_id,
            backend_status="completed",
            output_metadata_key=output_metadata_storage_key,
        )
    except (E2BModelRunnerError, SageMakerExecutionError) as e:
        wandb_state = finish_wandb_run(
            wandb_state,
            success=False,
            summary={
                "requested_backend": requested_backend,
                "execution_backend": execution_backend,
                "backend_job_id": backend_job_id,
                "error": str(e),
            },
        )
        full_log = str(e)
        run_log_path = TEMP_DIR / str(task_id) / "output" / "run.log"
        run_log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(run_log_path, "w", encoding="utf-8") as f:
            f.write(full_log)
        try:
            upload_file(output_run_log_key(task_id), run_log_path, content_type="text/plain")
        except Exception:
            pass
        failed_metadata_key: Optional[str] = None
        try:
            metadata_path = run_log_path.parent / "metadata.json"
            failed_metadata = {
                "task_id": str(task_id),
                "status": "failed",
                "error": str(e),
                "requested_backend": requested_backend,
                "execution_backend": execution_backend,
                "backend_job_id": backend_job_id,
                "wandb": wandb_state_to_metadata(wandb_state, wandb),
            }
            with open(metadata_path, "w", encoding="utf-8") as f:
                json.dump(failed_metadata, f, indent=2)
            failed_metadata_key = output_metadata_key(task_id)
            upload_file(failed_metadata_key, metadata_path, content_type="application/json")
        except Exception:
            failed_metadata_key = None
        update_task(
            task_id,
            status="failed",
            run_log_key=output_run_log_key(task_id),
            error_message=str(e)[:2000],
            stderr=str(e),
            requested_backend=requested_backend,
            execution_backend=execution_backend,
            backend_job_id=backend_job_id,
            backend_status="failed",
            output_metadata_key=failed_metadata_key,
        )
    except Exception as e:
        wandb_state = finish_wandb_run(
            wandb_state,
            success=False,
            summary={
                "requested_backend": requested_backend,
                "execution_backend": execution_backend,
                "backend_job_id": backend_job_id,
                "error": str(e),
            },
        )
        failed_metadata_key: Optional[str] = None
        try:
            metadata_path = TEMP_DIR / str(task_id) / "output" / "metadata.json"
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            failed_metadata = {
                "task_id": str(task_id),
                "status": "failed",
                "error": str(e),
                "requested_backend": requested_backend,
                "execution_backend": execution_backend,
                "backend_job_id": backend_job_id,
                "wandb": wandb_state_to_metadata(wandb_state, wandb),
            }
            with open(metadata_path, "w", encoding="utf-8") as f:
                json.dump(failed_metadata, f, indent=2)
            failed_metadata_key = output_metadata_key(task_id)
            upload_file(failed_metadata_key, metadata_path, content_type="application/json")
        except Exception:
            failed_metadata_key = None
        update_task(
            task_id,
            status="failed",
            error_message=str(e),
            requested_backend=requested_backend,
            execution_backend=execution_backend,
            backend_job_id=backend_job_id,
            backend_status="failed",
            output_metadata_key=failed_metadata_key,
        )


# ---- Upload-by-reference (main): JSON body ----
from pydantic import BaseModel, ConfigDict


class ExtraInputRef(BaseModel):
    name: str
    url: Optional[str] = None
    key: Optional[str] = None


class HfPrefetchRef(BaseModel):
    repo: str
    revision: Optional[str] = None
    allow_patterns: Optional[List[str]] = None
    ignore_patterns: Optional[List[str]] = None


class GithubPrefetchRef(BaseModel):
    repo: str
    ref: Optional[str] = None
    subdir: Optional[str] = None
    include_paths: Optional[List[str]] = None
    exclude_paths: Optional[List[str]] = None


class KaggleDatasetPrefetchRef(BaseModel):
    dataset: str
    target_dir: Optional[str] = None
    unzip: Optional[bool] = True


class WandbTrackingConfig(BaseModel):
    project: Optional[str] = None
    entity: Optional[str] = None
    run_name: Optional[str] = None
    tags: Optional[List[str]] = None
    notes: Optional[str] = None
    mode: Optional[Literal["online", "offline", "disabled"]] = "online"
    config: Optional[dict[str, Any]] = None


class SageMakerExecutionConfig(BaseModel):
    training_job_name: Optional[str] = None
    execution_role_arn: Optional[str] = None
    image_uri: Optional[str] = None
    instance_type: Optional[str] = None
    instance_count: Optional[int] = None
    volume_size_gb: Optional[int] = None
    max_runtime_seconds: Optional[int] = None
    output_s3_uri: Optional[str] = None
    hyperparameters: Optional[dict[str, str]] = None


class TaskSubmitByReferenceBody(BaseModel):
    # Backwards compatible CSV fields
    csv_url: Optional[str] = None
    csv_key: Optional[str] = None
    # Generic input fields
    input_url: Optional[str] = None
    input_key: Optional[str] = None
    input_name: Optional[str] = None
    # Script fields
    script_url: Optional[str] = None
    script_key: Optional[str] = None
    # Optional extras
    extra_inputs: Optional[List[ExtraInputRef]] = None
    hf_models: Optional[List[HfPrefetchRef]] = None
    hf_datasets: Optional[List[HfPrefetchRef]] = None
    github_repos: Optional[List[GithubPrefetchRef]] = None
    kaggle_datasets: Optional[List[KaggleDatasetPrefetchRef]] = None
    hf_token: Optional[str] = None
    github_token: Optional[str] = None
    kaggle_token: Optional[str] = None
    backend: Optional[Literal["e2b", "sagemaker"]] = "e2b"
    sagemaker: Optional[SageMakerExecutionConfig] = None
    wandb: Optional[WandbTrackingConfig] = None
    expected_output_name: Optional[str] = "model.pkl"
    timeout_seconds: Optional[int] = None


class SessionCreateBody(BaseModel):
    workdir: Optional[str] = "/code"


class SessionExecBody(BaseModel):
    command: str
    cwd: Optional[str] = None
    timeout_seconds: Optional[int] = None
    env: Optional[dict[str, str]] = None


class SessionCommandBody(BaseModel):
    command: str
    cwd: Optional[str] = None
    timeout_seconds: Optional[int] = None
    env: Optional[dict[str, str]] = None
    background: Optional[bool] = False
    stream: Optional[bool] = True


class SessionCommandStdinBody(BaseModel):
    data: str


class SessionPtyCreateBody(BaseModel):
    rows: Optional[int] = 24
    cols: Optional[int] = 80
    cwd: Optional[str] = None
    env: Optional[dict[str, str]] = None
    timeout_seconds: Optional[int] = None
    stream: Optional[bool] = True


class SessionPtyStdinBody(BaseModel):
    data: str


class SessionPtyResizeBody(BaseModel):
    rows: int
    cols: int


class DesktopSessionCreateBody(BaseModel):
    resolution: Optional[tuple[int, int]] = None
    dpi: Optional[int] = None
    display: Optional[str] = None
    timeout_seconds: Optional[int] = None
    env: Optional[dict[str, str]] = None


class DesktopActionBody(BaseModel):
    # Allow passing action params either inside `params` or at the top-level of each action
    # object (e.g. { action:"press", keys:"ctrl+l" }). We fold those extras into params server-side.
    model_config = ConfigDict(extra="allow")
    action: str
    params: Optional[dict[str, Any]] = None


class DesktopActionsBody(BaseModel):
    actions: List[DesktopActionBody]


class DesktopStreamStartBody(BaseModel):
    window_id: Optional[str] = None
    require_auth: Optional[bool] = True


class SessionFileInput(BaseModel):
    path: str
    content_base64: Optional[str] = None
    content_text: Optional[str] = None


class SessionFilesBody(BaseModel):
    files: List[SessionFileInput]


class SessionBrowserBody(BaseModel):
    url: str
    action: Optional[str] = "screenshot"  # screenshot | html | text
    selector: Optional[str] = None
    wait_ms: Optional[int] = None
    viewport: Optional[dict[str, int]] = None


class SessionKaggleDatasetDownloadBody(BaseModel):
    dataset: str
    target_dir: Optional[str] = "/code/kaggle"
    unzip: Optional[bool] = True
    kaggle_token: Optional[str] = None
    timeout_seconds: Optional[int] = 600


class SessionKaggleDatasetUploadBody(BaseModel):
    source_dir: str
    dataset_slug: str
    title: Optional[str] = None
    private: Optional[bool] = True
    message: Optional[str] = None
    kaggle_token: Optional[str] = None
    timeout_seconds: Optional[int] = 900


class SessionKaggleCompetitionSubmitBody(BaseModel):
    competition: str
    file_path: str
    message: Optional[str] = None
    kaggle_token: Optional[str] = None
    timeout_seconds: Optional[int] = 600


class SessionKaggleKernelPushBody(BaseModel):
    source_dir: str
    kernel_slug: str
    title: Optional[str] = None
    competition: Optional[str] = None
    enable_gpu: Optional[bool] = False
    enable_internet: Optional[bool] = True
    kaggle_token: Optional[str] = None
    timeout_seconds: Optional[int] = 900


@app.post("/tasks", dependencies=[Depends(_require_auth)])
async def submit_task(
    csv: Optional[UploadFile] = File(None),
    input_file: Optional[UploadFile] = File(None),
    script: Optional[UploadFile] = File(None),
):
    """
    Submit a task with multipart form (file upload) only.
    Send form fields: csv (file) or input (file), script (file, .py). Returns task_id (202).
    For JSON (e.g. agents): use POST /tasks/by-reference instead.
    """
    primary = csv or input_file
    if primary and script:
        return await _submit_multipart(primary, script)
    raise HTTPException(
        status_code=400,
        detail="Multipart only: send form fields 'csv' (or 'input') and 'script'. For JSON (by reference), use POST /tasks/by-reference with input_url+script_url or input_key+script_key.",
    )


@app.post("/tasks/by-reference", dependencies=[Depends(_require_auth)])
async def submit_task_by_reference(body: TaskSubmitByReferenceBody):
    """
    Submit by reference (recommended for agents). Send JSON:
    { "input_url": "...", "script_url": "..." } or { "input_key": "...", "script_key": "..." }
    (csv_* is accepted for backward compatibility.)
    Optional: expected_output_name, timeout_seconds, hf_models/hf_datasets/github_repos/kaggle_datasets,
    hf_token/github_token/kaggle_token, backend, sagemaker, wandb.
    """
    if (body.input_url and body.script_url) or (body.input_key and body.script_key):
        return await _submit_by_reference(body)
    if (body.csv_url and body.script_url) or (body.csv_key and body.script_key):
        return await _submit_by_reference(body)
    raise HTTPException(
        status_code=400,
        detail="Provide both input_url and script_url, or both input_key and script_key (csv_* is accepted for compatibility).",
    )


async def _submit_by_reference(body: TaskSubmitByReferenceBody) -> JSONResponse:
    max_input_bytes = _parse_int_env("RUNNER_MAX_INPUT_BYTES", 20_000_000)
    backend = (body.backend or "e2b").strip().lower()
    if backend not in {"e2b", "sagemaker"}:
        raise HTTPException(status_code=400, detail="backend must be one of: e2b, sagemaker")
    input_url = body.input_url or body.csv_url
    input_key = body.input_key or body.csv_key
    script_url = body.script_url
    script_key = body.script_key
    if not ((input_url and script_url) or (input_key and script_key)):
        raise HTTPException(
            status_code=400,
            detail="Provide both input_url and script_url, or both input_key and script_key (csv_* is accepted).",
        )

    task_id = create_task(
        expected_output_name=body.expected_output_name,
        timeout_seconds=body.timeout_seconds,
        requested_backend=backend,
    )
    work = TEMP_DIR / str(task_id) / "input"
    work.mkdir(parents=True, exist_ok=True)

    def safe_name(value: Optional[str], fallback: str) -> str:
        raw = (value or "").strip().replace("/", "_")
        return raw or fallback

    inferred_name = ""
    if input_url:
        inferred_name = Path(input_url).name
    elif input_key:
        inferred_name = Path(input_key).name
    input_name = safe_name(body.input_name or inferred_name, "input.csv")

    input_path = work / input_name
    script_path = work / "train.py"
    extra_inputs: List[tuple[str, str]] = []
    hf_models = [item.model_dump(exclude_none=True) for item in (body.hf_models or [])]
    hf_datasets = [item.model_dump(exclude_none=True) for item in (body.hf_datasets or [])]
    github_repos = [item.model_dump(exclude_none=True) for item in (body.github_repos or [])]
    kaggle_datasets = [item.model_dump(exclude_none=True) for item in (body.kaggle_datasets or [])]
    sagemaker = body.sagemaker.model_dump(exclude_none=True) if body.sagemaker else None
    wandb = body.wandb.model_dump(exclude_none=True) if body.wandb else None
    hf_token = (body.hf_token or "").strip() or None
    github_token = (body.github_token or "").strip() or None
    kaggle_token = (body.kaggle_token or "").strip() or None

    try:
        if input_url and script_url:
            async with httpx.AsyncClient(timeout=60.0) as client:
                r_input = await client.get(input_url)
                r_input.raise_for_status()
                if len(r_input.content) > max_input_bytes:
                    raise HTTPException(status_code=400, detail="Input file too large")
                input_path.write_bytes(r_input.content)
                r_script = await client.get(script_url)
                r_script.raise_for_status()
                script_path.write_bytes(r_script.content)
                for extra in body.extra_inputs or []:
                    if not extra.url:
                        raise HTTPException(status_code=400, detail="extra_inputs url missing")
                    extra_name = safe_name(extra.name, "extra")
                    extra_path = work / extra_name
                    r_extra = await client.get(extra.url)
                    r_extra.raise_for_status()
                    if len(r_extra.content) > max_input_bytes:
                        raise HTTPException(status_code=400, detail=f"Extra input too large: {extra_name}")
                    extra_path.write_bytes(r_extra.content)
                    extra_inputs.append((extra_name, str(extra_path)))
        else:
            download_to_path(input_key, input_path)
            download_to_path(script_key, script_path)
            for extra in body.extra_inputs or []:
                if not extra.key:
                    raise HTTPException(status_code=400, detail="extra_inputs key missing")
                extra_name = safe_name(extra.name, "extra")
                extra_path = work / extra_name
                download_to_path(extra.key, extra_path)
                extra_inputs.append((extra_name, str(extra_path)))
    except httpx.HTTPError as e:
        update_task(task_id, status="failed", error_message=f"Download failed: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to download inputs: {e}")
    except Exception as e:
        update_task(task_id, status="failed", error_message=str(e))
        raise HTTPException(status_code=400, detail=f"Failed to fetch inputs: {e}")

    try:
        input_key_to_store = input_file_key(task_id, input_name)
        upload_file(input_key_to_store, input_path)
        upload_file(input_script_key(task_id), script_path)
        update_task(task_id, input_csv_key=input_key_to_store, script_key=input_script_key(task_id))
    except Exception:
        pass  # non-fatal; run can still proceed

    _executor.submit(
        _run_task,
        task_id,
        str(input_path),
        str(script_path),
        input_name,
        body.expected_output_name or "model.pkl",
        extra_inputs,
        hf_models,
        hf_datasets,
        github_repos,
        hf_token,
        github_token,
        kaggle_datasets,
        kaggle_token,
        backend,
        sagemaker,
        wandb,
    )
    return JSONResponse(content={"task_id": str(task_id)}, status_code=202)


async def _submit_multipart(input_file: UploadFile, script: UploadFile) -> JSONResponse:
    if not script.filename or not script.filename.endswith(".py"):
        raise HTTPException(status_code=400, detail="script must be a .py file")
    max_input_bytes = _parse_int_env("RUNNER_MAX_INPUT_BYTES", 20_000_000)
    task_id = create_task(requested_backend="e2b")
    input_name = (input_file.filename or "input.csv").replace("/", "_")
    input_key = input_file_key(task_id, input_name)
    script_key = input_script_key(task_id)
    try:
        content_input = await input_file.read()
        if len(content_input) > max_input_bytes:
            raise HTTPException(status_code=400, detail="Input file too large")
        upload_bytes(input_key, content_input, input_file.content_type or "application/octet-stream")
        upload_bytes(script_key, await script.read(), "text/x-python")
    except HTTPException:
        raise
    except Exception as e:
        update_task(task_id, status="failed", error_message=str(e))
        raise HTTPException(status_code=500, detail="Failed to upload to Storage")
    update_task(task_id, input_csv_key=input_key, script_key=script_key)
    work = TEMP_DIR / str(task_id) / "input"
    work.mkdir(parents=True, exist_ok=True)
    download_to_path(input_key, work / input_name)
    download_to_path(script_key, work / "train.py")
    _executor.submit(
        _run_task,
        task_id,
        str(work / input_name),
        str(work / "train.py"),
        input_name,
        "model.pkl",
        None,
    )
    return JSONResponse(content={"task_id": str(task_id)}, status_code=202)


@app.get("/tasks/{task_id}/status", dependencies=[Depends(_require_auth)])
async def task_status(task_id: uuid.UUID):
    """Get task status from Supabase (Postgres)."""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return {
        "task_id": str(task_id),
        "status": task["status"],
        "created_at": task["created_at"],
        "updated_at": task["updated_at"],
        "input_csv_key": task.get("input_csv_key"),
        "script_key": task.get("script_key"),
        "output_model_key": task.get("output_model_key"),
        "run_log_key": task.get("run_log_key"),
        "error_message": task.get("error_message"),
        "attempts": task.get("attempts"),
        "stdout": task.get("stdout"),
        "stderr": task.get("stderr"),
        "requested_backend": task.get("requested_backend"),
        "execution_backend": task.get("execution_backend"),
        "backend_job_id": task.get("backend_job_id"),
        "backend_status": task.get("backend_status"),
        "output_metadata_key": task.get("output_metadata_key"),
    }


@app.get("/tasks/{task_id}/output", dependencies=[Depends(_require_auth)])
async def task_output_model(task_id: uuid.UUID):
    """Download the output model file (from Storage). Direct download for testing."""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=400, detail=f"Task not completed (status={task['status']}).")
    key = task.get("output_model_key")
    if not key:
        raise HTTPException(status_code=404, detail="No output model")
    try:
        data = download_bytes(key)
    except Exception:
        raise HTTPException(status_code=404, detail="Output file not found in Storage")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{Path(key).name}"'},
    )


@app.get("/tasks/{task_id}/output/log", dependencies=[Depends(_require_auth)])
async def task_output_log(task_id: uuid.UUID):
    """Download full run log (run.log from Storage). Available after run completes or fails."""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    key = task.get("run_log_key") or output_run_log_key(task_id)
    try:
        data = download_bytes(key)
    except Exception:
        raise HTTPException(status_code=404, detail="Log not found in Storage")
    return Response(content=data, media_type="text/plain", headers={"Content-Disposition": 'attachment; filename="run.log"'})


@app.get("/tasks/{task_id}/output/metadata", dependencies=[Depends(_require_auth)])
async def task_output_metadata(task_id: uuid.UUID):
    """Get metadata.json (JSON). Available for completed or failed tasks."""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] not in {"completed", "failed"}:
        raise HTTPException(status_code=400, detail="Metadata available when task is completed or failed")
    key = task.get("output_metadata_key") or output_metadata_key(task_id)
    try:
        data = download_bytes(key)
        return JSONResponse(content=json.loads(data))
    except Exception:
        raise HTTPException(status_code=404, detail="Metadata not found")


@app.get("/tasks/{task_id}/download", dependencies=[Depends(_require_auth)])
async def task_download(task_id: uuid.UUID, file: str = "model"):
    """
    Direct download by file type: ?file=model | log | metadata.
    Convenience for test UI (single endpoint to get any output).
    """
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if file == "model":
        if task["status"] != "completed":
            raise HTTPException(status_code=400, detail="Model available only when completed")
        key = task.get("output_model_key")
        if not key:
            raise HTTPException(status_code=404, detail="No output model")
        data = download_bytes(key)
        return Response(content=data, media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{Path(key).name}"'})
    if file == "log":
        key = output_run_log_key(task_id)
        try:
            data = download_bytes(key)
        except Exception:
            raise HTTPException(status_code=404, detail="Log not found")
        return Response(content=data, media_type="text/plain", headers={"Content-Disposition": 'attachment; filename="run.log"'})
    if file == "metadata":
        if task["status"] not in {"completed", "failed"}:
            raise HTTPException(status_code=400, detail="Metadata available when task is completed or failed")
        key = task.get("output_metadata_key") or output_metadata_key(task_id)
        try:
            data = download_bytes(key)
            return JSONResponse(content=json.loads(data))
        except Exception:
            raise HTTPException(status_code=404, detail="Metadata not found")
    raise HTTPException(status_code=400, detail="file must be model, log, or metadata")


@app.post("/sessions", dependencies=[Depends(_require_auth)])
async def create_session(body: Optional[SessionCreateBody] = None):
    """Create a new interactive E2B sandbox session."""
    session_manager.cleanup_expired()
    workdir = _normalize_session_workdir(body.workdir if body else None)
    try:
        entry = session_manager.create(workdir=workdir)
    except E2BModelRunnerError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"session_id": entry.id, "workdir": entry.workdir}


@app.post("/sessions/{session_id}/exec", dependencies=[Depends(_require_auth)])
async def session_exec(session_id: str, body: SessionExecBody):
    """Execute a command inside the session sandbox."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        result = exec_command(
            entry,
            command=body.command,
            cwd=body.cwd,
            timeout_seconds=body.timeout_seconds,
            env=body.env,
        )
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.post("/sessions/{session_id}/commands", dependencies=[Depends(_require_auth)])
async def session_command_start(session_id: str, body: SessionCommandBody):
    """Run a command (foreground or background) via sandbox commands API."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        result = start_command(
            entry,
            command=body.command,
            cwd=body.cwd,
            timeout_seconds=body.timeout_seconds,
            env=body.env,
            background=bool(body.background),
            stream=bool(body.stream) if body.stream is not None else True,
        )
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.get("/sessions/{session_id}/commands/{pid}", dependencies=[Depends(_require_auth)])
async def session_command_status(session_id: str, pid: str):
    """Get status/output for a background command."""
    session_manager.cleanup_expired()
    try:
        pid_int = int(pid)
    except Exception:
        raise HTTPException(status_code=400, detail="pid must be an integer")
    try:
        entry = session_manager.get(session_id)
        result = command_status(entry, pid_int)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.post("/sessions/{session_id}/commands/{pid}/stdin", dependencies=[Depends(_require_auth)])
async def session_command_stdin(session_id: str, pid: str, body: SessionCommandStdinBody):
    """Send stdin to a running command."""
    session_manager.cleanup_expired()
    try:
        pid_int = int(pid)
    except Exception:
        raise HTTPException(status_code=400, detail="pid must be an integer")
    try:
        entry = session_manager.get(session_id)
        result = command_send_stdin(entry, pid_int, body.data)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.post("/sessions/{session_id}/commands/{pid}/kill", dependencies=[Depends(_require_auth)])
async def session_command_kill(session_id: str, pid: str):
    """Kill a running background command."""
    session_manager.cleanup_expired()
    try:
        pid_int = int(pid)
    except Exception:
        raise HTTPException(status_code=400, detail="pid must be an integer")
    try:
        entry = session_manager.get(session_id)
        result = command_kill(entry, pid_int)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.post("/sessions/{session_id}/pty", dependencies=[Depends(_require_auth)])
async def session_pty_create(session_id: str, body: SessionPtyCreateBody):
    """Create a PTY session for interactive terminal usage."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        rows = int(body.rows or 24)
        cols = int(body.cols or 80)
        result = create_pty(
            entry,
            rows=rows,
            cols=cols,
            cwd=body.cwd,
            env=body.env,
            timeout_seconds=body.timeout_seconds,
            stream=bool(body.stream) if body.stream is not None else True,
        )
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.get("/sessions/{session_id}/pty/{pid}", dependencies=[Depends(_require_auth)])
async def session_pty_status(session_id: str, pid: str, after: int = 0):
    """Get PTY output and status."""
    session_manager.cleanup_expired()
    try:
        pid_int = int(pid)
    except Exception:
        raise HTTPException(status_code=400, detail="pid must be an integer")
    try:
        entry = session_manager.get(session_id)
        result = pty_status(entry, pid_int, after=after)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.post("/sessions/{session_id}/pty/{pid}/stdin", dependencies=[Depends(_require_auth)])
async def session_pty_stdin(session_id: str, pid: str, body: SessionPtyStdinBody):
    """Send input to a PTY."""
    session_manager.cleanup_expired()
    try:
        pid_int = int(pid)
    except Exception:
        raise HTTPException(status_code=400, detail="pid must be an integer")
    try:
        entry = session_manager.get(session_id)
        result = pty_send(entry, pid_int, body.data)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.post("/sessions/{session_id}/pty/{pid}/resize", dependencies=[Depends(_require_auth)])
async def session_pty_resize(session_id: str, pid: str, body: SessionPtyResizeBody):
    """Resize the PTY."""
    session_manager.cleanup_expired()
    try:
        pid_int = int(pid)
    except Exception:
        raise HTTPException(status_code=400, detail="pid must be an integer")
    try:
        entry = session_manager.get(session_id)
        result = pty_resize(entry, pid_int, rows=body.rows, cols=body.cols)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.post("/sessions/{session_id}/pty/{pid}/kill", dependencies=[Depends(_require_auth)])
async def session_pty_kill(session_id: str, pid: str):
    """Kill the PTY."""
    session_manager.cleanup_expired()
    try:
        pid_int = int(pid)
    except Exception:
        raise HTTPException(status_code=400, detail="pid must be an integer")
    try:
        entry = session_manager.get(session_id)
        result = pty_kill(entry, pid_int)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.post("/sessions/{session_id}/files", dependencies=[Depends(_require_auth)])
async def session_upload_files(session_id: str, body: SessionFilesBody):
    """Upload one or more files into the session sandbox."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        result = write_files(entry, [f.model_dump() for f in body.files])
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, **result}


@app.get("/sessions/{session_id}/files", dependencies=[Depends(_require_auth)])
async def session_list_files(session_id: str, path: Optional[str] = None):
    """List files in the session sandbox."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        list_path = path if path and path.strip() else entry.workdir
        items = list_files(entry, list_path)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"session_id": session_id, "path": list_path, "items": items}


@app.get("/sessions/{session_id}/files/content", dependencies=[Depends(_require_auth)])
async def session_download_file(session_id: str, path: str):
    """Download a file from the session sandbox."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        data = read_file(entry, path)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    name = Path(path).name or "file"
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@app.post("/sessions/{session_id}/browser", dependencies=[Depends(_require_auth)])
async def session_browser(session_id: str, body: SessionBrowserBody):
    """Run a browser action inside the sandbox (Playwright)."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        result = run_browser_action(entry, body.model_dump())
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return result


@app.post("/sessions/{session_id}/kaggle/datasets/download", dependencies=[Depends(_require_auth)])
async def session_kaggle_dataset_download(session_id: str, body: SessionKaggleDatasetDownloadBody):
    """Download a Kaggle dataset into the sandbox session."""
    session_manager.cleanup_expired()
    token = (body.kaggle_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="kaggle_token is required")
    target_dir = _normalize_session_workdir(body.target_dir or "/code/kaggle")
    try:
        entry = session_manager.get(session_id)
        command = build_kaggle_dataset_download_command(
            dataset=body.dataset,
            target_dir=target_dir,
            unzip=bool(body.unzip) if body.unzip is not None else True,
        )
        result = exec_command(
            entry,
            command=command,
            cwd=entry.workdir,
            timeout_seconds=body.timeout_seconds,
            env={"KAGGLE_TOKEN_VALUE": token},
        )
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {
        "session_id": session_id,
        "action": "kaggle_dataset_download",
        "dataset": body.dataset,
        "target_dir": target_dir,
        **result,
    }


@app.post("/sessions/{session_id}/kaggle/datasets/upload", dependencies=[Depends(_require_auth)])
async def session_kaggle_dataset_upload(session_id: str, body: SessionKaggleDatasetUploadBody):
    """Upload/version a Kaggle dataset from files in the sandbox session."""
    session_manager.cleanup_expired()
    token = (body.kaggle_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="kaggle_token is required")
    source_dir = _normalize_session_workdir(body.source_dir)
    try:
        entry = session_manager.get(session_id)
        command = build_kaggle_dataset_upload_command(
            source_dir=source_dir,
            dataset_slug=body.dataset_slug,
            title=body.title,
            private=bool(body.private) if body.private is not None else True,
            message=body.message,
        )
        env = {
            "KAGGLE_TOKEN_VALUE": token,
            "KAGGLE_SOURCE_DIR": source_dir,
            "KAGGLE_DATASET_SLUG": body.dataset_slug,
            "KAGGLE_DATASET_TITLE": (body.title or body.dataset_slug.split("/")[-1]).strip(),
            "KAGGLE_DATASET_PRIVACY": "private" if (bool(body.private) if body.private is not None else True) else "public",
        }
        result = exec_command(
            entry,
            command=command,
            cwd=entry.workdir,
            timeout_seconds=body.timeout_seconds,
            env=env,
        )
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {
        "session_id": session_id,
        "action": "kaggle_dataset_upload",
        "source_dir": source_dir,
        "dataset_slug": body.dataset_slug,
        **result,
    }


@app.post("/sessions/{session_id}/kaggle/competitions/submit", dependencies=[Depends(_require_auth)])
async def session_kaggle_competition_submit(session_id: str, body: SessionKaggleCompetitionSubmitBody):
    """Submit a prediction file to a Kaggle competition."""
    session_manager.cleanup_expired()
    token = (body.kaggle_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="kaggle_token is required")
    file_path = _normalize_session_workdir(body.file_path)
    message_text = (body.message or "Submission from tuna runner").strip()
    try:
        entry = session_manager.get(session_id)
        command = build_kaggle_competition_submit_command(
            competition=body.competition,
            file_path=file_path,
            message=message_text,
        )
        result = exec_command(
            entry,
            command=command,
            cwd=entry.workdir,
            timeout_seconds=body.timeout_seconds,
            env={"KAGGLE_TOKEN_VALUE": token},
        )
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {
        "session_id": session_id,
        "action": "kaggle_competition_submit",
        "competition": body.competition,
        "file_path": file_path,
        **result,
    }


@app.post("/sessions/{session_id}/kaggle/kernels/push", dependencies=[Depends(_require_auth)])
async def session_kaggle_kernel_push(session_id: str, body: SessionKaggleKernelPushBody):
    """Push a Kaggle notebook/script (kernel) from sandbox files."""
    session_manager.cleanup_expired()
    token = (body.kaggle_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="kaggle_token is required")
    source_dir = _normalize_session_workdir(body.source_dir)
    try:
        entry = session_manager.get(session_id)
        command = build_kaggle_kernel_push_command(
            source_dir=source_dir,
            kernel_slug=body.kernel_slug,
            title=body.title,
            competition=body.competition,
            enable_gpu=bool(body.enable_gpu),
            enable_internet=bool(body.enable_internet) if body.enable_internet is not None else True,
        )
        env = {
            "KAGGLE_TOKEN_VALUE": token,
            "KAGGLE_SOURCE_DIR": source_dir,
            "KAGGLE_KERNEL_SLUG": body.kernel_slug,
            "KAGGLE_KERNEL_TITLE": (body.title or body.kernel_slug.split("/")[-1]).strip(),
            "KAGGLE_COMPETITION": (body.competition or "").strip(),
            "KAGGLE_ENABLE_GPU": "1" if bool(body.enable_gpu) else "0",
            "KAGGLE_ENABLE_INTERNET": "1" if (bool(body.enable_internet) if body.enable_internet is not None else True) else "0",
        }
        result = exec_command(
            entry,
            command=command,
            cwd=entry.workdir,
            timeout_seconds=body.timeout_seconds,
            env=env,
        )
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {
        "session_id": session_id,
        "action": "kaggle_kernel_push",
        "source_dir": source_dir,
        "kernel_slug": body.kernel_slug,
        **result,
    }


@app.get("/sessions/{session_id}/status", dependencies=[Depends(_require_auth)])
async def session_status(session_id: str):
    """Get the latest session status."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        return session_manager.status_payload(entry)
    except E2BModelRunnerError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/sessions/{session_id}/events", dependencies=[Depends(_require_auth)])
async def session_events(session_id: str, after: int = 0, limit: int = 200):
    """Get session event history (incremental)."""
    session_manager.cleanup_expired()
    try:
        entry = session_manager.get(session_id)
        return session_manager.list_events(entry, after=after, limit=limit)
    except E2BModelRunnerError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/sessions/{session_id}", dependencies=[Depends(_require_auth)])
async def session_delete(session_id: str):
    """Delete/close a sandbox session."""
    session_manager.cleanup_expired()
    try:
        session_manager.get(session_id)
        session_manager.delete(session_id)
        return {"session_id": session_id, "deleted": True}
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)


@app.post("/desktop/sessions", dependencies=[Depends(_require_auth)])
async def desktop_create_session(body: Optional[DesktopSessionCreateBody] = None):
    """Create a new desktop sandbox session."""
    desktop_session_manager.cleanup_expired()
    payload = body or DesktopSessionCreateBody()
    try:
        entry = desktop_session_manager.create(
            resolution=payload.resolution,
            dpi=payload.dpi,
            display=payload.display,
            timeout_seconds=payload.timeout_seconds,
            env=payload.env,
        )
    except E2BModelRunnerError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "desktop_session_id": entry.id,
        "resolution": entry.resolution,
        "dpi": entry.dpi,
        "display": entry.display,
    }


@app.get("/desktop/sessions/{desktop_session_id}", dependencies=[Depends(_require_auth)])
async def desktop_session_status(desktop_session_id: str):
    """Get desktop session status."""
    desktop_session_manager.cleanup_expired()
    try:
        entry = desktop_session_manager.get(desktop_session_id)
        return desktop_session_manager.status_payload(entry)
    except E2BModelRunnerError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/desktop/sessions/{desktop_session_id}/events", dependencies=[Depends(_require_auth)])
async def desktop_session_events(desktop_session_id: str, after: int = 0, limit: int = 200):
    """Get desktop session event history (supports after + limit)."""
    desktop_session_manager.cleanup_expired()
    try:
        entry = desktop_session_manager.get(desktop_session_id)
        return desktop_session_manager.list_events(entry, after=after, limit=limit)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)


@app.get("/desktop/sessions/{desktop_session_id}/recording", dependencies=[Depends(_require_auth)])
async def desktop_session_recording(desktop_session_id: str, after: int = 0, limit: int = 200):
    """Get desktop recording frames (supports after + limit)."""
    desktop_session_manager.cleanup_expired()
    try:
        entry = desktop_session_manager.get(desktop_session_id)
        return desktop_get_recording_payload(entry, after=after, limit=limit)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)


@app.post("/desktop/sessions/{desktop_session_id}/actions", dependencies=[Depends(_require_auth)])
async def desktop_session_actions(desktop_session_id: str, body: DesktopActionsBody):
    """Run one or more desktop actions."""
    desktop_session_manager.cleanup_expired()
    try:
        entry = desktop_session_manager.get(desktop_session_id)
        actions = [a.model_dump() for a in body.actions]
        results = desktop_run_actions(entry, actions)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"desktop_session_id": desktop_session_id, "results": results}


@app.get("/desktop/sessions/{desktop_session_id}/screenshot", dependencies=[Depends(_require_auth)])
async def desktop_session_screenshot(desktop_session_id: str):
    """Get a PNG screenshot of the desktop session."""
    desktop_session_manager.cleanup_expired()
    try:
        entry = desktop_session_manager.get(desktop_session_id)
        data = desktop_take_screenshot(entry)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return Response(content=data, media_type="image/png")


@app.post("/desktop/sessions/{desktop_session_id}/stream/start", dependencies=[Depends(_require_auth)])
async def desktop_session_stream_start(desktop_session_id: str, body: Optional[DesktopStreamStartBody] = None):
    """Start desktop streaming and return a stream URL."""
    desktop_session_manager.cleanup_expired()
    payload = body or DesktopStreamStartBody()
    try:
        entry = desktop_session_manager.get(desktop_session_id)
        result = desktop_start_stream(entry, window_id=payload.window_id, require_auth=bool(payload.require_auth))
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"desktop_session_id": desktop_session_id, **result}


@app.get("/desktop/sessions/{desktop_session_id}/stream", dependencies=[Depends(_require_auth)])
async def desktop_session_stream_url(desktop_session_id: str):
    """Get the current desktop stream URL."""
    desktop_session_manager.cleanup_expired()
    try:
        entry = desktop_session_manager.get(desktop_session_id)
        result = desktop_get_stream_url(entry)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"desktop_session_id": desktop_session_id, **result}


@app.post("/desktop/sessions/{desktop_session_id}/stream/stop", dependencies=[Depends(_require_auth)])
async def desktop_session_stream_stop(desktop_session_id: str):
    """Stop desktop streaming."""
    desktop_session_manager.cleanup_expired()
    try:
        entry = desktop_session_manager.get(desktop_session_id)
        result = desktop_stop_stream(entry)
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)
    return {"desktop_session_id": desktop_session_id, **result}


@app.post("/desktop/sessions/{desktop_session_id}/close", dependencies=[Depends(_require_auth)])
async def desktop_session_close(desktop_session_id: str):
    """Close a desktop session."""
    desktop_session_manager.cleanup_expired()
    try:
        desktop_session_manager.get(desktop_session_id)
        desktop_session_manager.delete(desktop_session_id)
        return {"desktop_session_id": desktop_session_id, "closed": True}
    except E2BModelRunnerError as e:
        message = str(e)
        raise HTTPException(status_code=_session_error_status(message), detail=message)


@app.get("/config", dependencies=[Depends(_require_auth)])
async def config():
    """Whether Supabase is configured. When false, service runs in local mode (in-memory + local disk)."""
    return {"supabase_configured": supabase_configured()}


# Test UI
static_dir = Path(__file__).resolve().parent / "static"
if static_dir.is_dir():
    from fastapi.staticfiles import StaticFiles
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def root():
    if (static_dir / "index.html").exists():
        return FileResponse(static_dir / "index.html")
    return {
        "service": "e2b-runner",
        "docs": "/docs",
        "submit_multipart": "POST /tasks (multipart only)",
        "submit_json": "POST /tasks/by-reference (JSON, recommended for agents)",
    }
