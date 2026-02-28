from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
from uuid import UUID

try:
    import wandb
except Exception:
    wandb = None  # type: ignore


_SENSITIVE_KEY_RE = re.compile(r"(token|secret|password|api[_-]?key|authorization|cookie)", re.IGNORECASE)


def _sanitize_value(value: Any) -> Any:
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key, inner in value.items():
            if _SENSITIVE_KEY_RE.search(str(key)):
                out[str(key)] = "[redacted]"
            else:
                out[str(key)] = _sanitize_value(inner)
        return out
    if isinstance(value, list):
        return [_sanitize_value(item) for item in value]
    return value


def sanitize_wandb_payload(value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not value:
        return None
    return _sanitize_value(value)


def _normalize_mode(config: Dict[str, Any]) -> str:
    explicit = str(config.get("mode") or "").strip().lower()
    if explicit in {"online", "offline", "disabled"}:
        return explicit
    env_mode = (os.getenv("WANDB_MODE") or "").strip().lower()
    if env_mode in {"online", "offline", "disabled"}:
        return env_mode
    return "online"


@dataclass
class WandbRunState:
    enabled: bool
    mode: str
    project: Optional[str] = None
    entity: Optional[str] = None
    run_name: Optional[str] = None
    run_id: Optional[str] = None
    run_url: Optional[str] = None
    status: str = "not_started"
    notes: list[str] = field(default_factory=list)
    _run: Any = None


def start_wandb_run(
    *,
    task_id: UUID,
    requested_backend: str,
    execution_backend: str,
    wandb_config: Optional[Dict[str, Any]],
) -> WandbRunState:
    cfg = dict(wandb_config or {})
    mode = _normalize_mode(cfg)
    project = str(cfg.get("project") or os.getenv("WANDB_PROJECT") or "tuna").strip() or "tuna"
    entity_raw = str(cfg.get("entity") or os.getenv("WANDB_ENTITY") or "").strip()
    entity = entity_raw or None
    run_name = str(cfg.get("run_name") or f"tuna-{task_id.hex[:8]}").strip()
    state = WandbRunState(
        enabled=False,
        mode=mode,
        project=project,
        entity=entity,
        run_name=run_name,
    )

    if mode == "disabled":
        state.status = "disabled"
        return state

    if wandb is None:
        state.status = "unavailable"
        state.notes.append("wandb library not installed in runner environment")
        return state

    effective_mode = mode
    if mode == "online" and not (os.getenv("WANDB_API_KEY") or "").strip():
        effective_mode = "offline"
        state.notes.append("WANDB_API_KEY missing; falling back to offline mode")

    config_payload = sanitize_wandb_payload(cfg.get("config") if isinstance(cfg.get("config"), dict) else {})
    tags = cfg.get("tags") if isinstance(cfg.get("tags"), list) else None
    notes = str(cfg.get("notes") or "").strip() or None

    run = wandb.init(
        project=project,
        entity=entity,
        name=run_name,
        mode=effective_mode,
        config=config_payload or {},
        tags=tags,
        notes=notes,
        reinit=True,
        job_type="runner_training",
    )
    state.enabled = True
    state.mode = effective_mode
    state._run = run
    state.run_id = getattr(run, "id", None)
    state.run_url = getattr(run, "url", None)
    state.status = "running"

    run.summary["task_id"] = str(task_id)
    run.summary["requested_backend"] = requested_backend
    run.summary["execution_backend"] = execution_backend
    run.log({"runner/status": "running", "runner/timestamp": time.time()})
    return state


def log_wandb_status(state: Optional[WandbRunState], status: str, extra: Optional[Dict[str, Any]] = None) -> None:
    if not state or not state.enabled or state._run is None:
        return
    payload: Dict[str, Any] = {
        "runner/status": status,
        "runner/timestamp": time.time(),
    }
    safe_extra = sanitize_wandb_payload(extra or {})
    if safe_extra:
        for key, value in safe_extra.items():
            payload[f"runner/{key}"] = value
    state._run.log(payload)
    state.status = status


def finish_wandb_run(
    state: Optional[WandbRunState],
    *,
    success: bool,
    summary: Optional[Dict[str, Any]] = None,
) -> Optional[WandbRunState]:
    if not state:
        return None
    if not state.enabled or state._run is None:
        state.status = "completed" if success else "failed"
        return state

    safe_summary = sanitize_wandb_payload(summary or {})
    if safe_summary:
        for key, value in safe_summary.items():
            state._run.summary[str(key)] = value
    final_status = "completed" if success else "failed"
    state._run.log({"runner/status": final_status, "runner/timestamp": time.time()})
    state._run.finish(exit_code=0 if success else 1)
    state.status = final_status
    state.run_url = getattr(state._run, "url", state.run_url)
    state.run_id = getattr(state._run, "id", state.run_id)
    return state


def wandb_state_to_metadata(state: Optional[WandbRunState], user_config: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    safe_user = sanitize_wandb_payload(user_config or {})
    if state is None:
        return safe_user
    merged = dict(safe_user or {})
    merged.update(
        {
            "project": state.project,
            "entity": state.entity,
            "run_name": state.run_name,
            "run_id": state.run_id,
            "run_url": state.run_url,
            "mode": state.mode,
            "status": state.status,
            "notes_runtime": state.notes,
        }
    )
    return merged
