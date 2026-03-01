"""
In-memory E2B sandbox sessions for interactive exec/files/browser.
Sessions are ephemeral and cleaned up via TTL.
"""
from __future__ import annotations

import base64
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


from runner import (
    Sandbox,
    E2BModelRunnerError,
    bootstrap_e2b_python_dependencies,
    create_e2b_sandbox,
    get_e2b_import_error,
)


def _format_exec_logs(execution: Any) -> tuple[str, str]:
    stdout, stderr = "", ""
    try:
        logs = execution.logs
        if hasattr(logs, "stdout") and isinstance(logs.stdout, list):
            stdout = "".join(logs.stdout)
        if hasattr(logs, "stderr") and isinstance(logs.stderr, list):
            stderr = "".join(logs.stderr)
        return stdout, stderr
    except Exception:
        pass
    for attr in ("stdout", "text", "result"):
        if hasattr(execution, attr):
            try:
                stdout = str(getattr(execution, attr) or "")
                break
            except Exception:
                continue
    if hasattr(execution, "error"):
        try:
            stderr = str(execution.error or "")
        except Exception:
            stderr = ""
    return stdout, stderr


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except Exception:
        return default
    return value if value > 0 else default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except Exception:
        return default
    return value if value > 0 else default


@dataclass
class CommandState:
    pid: int
    command: str
    cwd: str
    started_at: float
    status: str = "running"
    stdout: str = ""
    stderr: str = ""
    exit_code: Optional[int] = None
    timed_out: bool = False
    finished_at: Optional[float] = None
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    last_emit_at: float = 0.0
    handle: Any = None
    stream: bool = True


@dataclass
class PtyState:
    pid: int
    rows: int
    cols: int
    cwd: str
    started_at: float
    status: str = "running"
    output: str = ""
    finished_at: Optional[float] = None
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    last_emit_at: float = 0.0
    handle: Any = None
    stream: bool = True


@dataclass
class SessionEntry:
    id: str
    sandbox: Any
    created_at: float
    last_access: float
    last_activity: float
    workdir: str
    status: str = "starting"
    status_updated_at: float = field(default_factory=time.time)
    events: List[Dict[str, Any]] = field(default_factory=list)
    next_seq: int = 1
    sandbox_timeout_refreshed_at: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)
    browser_ready: bool = False
    commands: Dict[int, CommandState] = field(default_factory=dict)
    ptys: Dict[int, PtyState] = field(default_factory=dict)


class SessionManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, SessionEntry] = {}
        self._ttl = _env_float("RUNNER_SESSION_TTL_SECONDS", 7200.0)
        self._creation_grace_seconds = _env_float("RUNNER_SESSION_CREATION_GRACE_SECONDS", 20.0)
        self._keepalive_interval_seconds = _env_float("RUNNER_SESSION_KEEPALIVE_INTERVAL_SECONDS", 0.0)
        self._max_sessions = _env_int("RUNNER_MAX_SESSIONS", 32)
        self._max_events = _env_int("RUNNER_MAX_EVENTS", 500)
        # E2B sandboxes default to ~5 minutes unless timeout is set.
        # Default to 1 hour (Base/Hobby max) and refresh on access.
        self._sandbox_timeout_seconds = _env_int("RUNNER_E2B_SANDBOX_TIMEOUT_SECONDS", 7200)
        self._sandbox_timeout_max_seconds = _env_int("RUNNER_E2B_SANDBOX_MAX_TIMEOUT_SECONDS", 7200)
        if self._sandbox_timeout_seconds > self._sandbox_timeout_max_seconds:
            self._sandbox_timeout_seconds = self._sandbox_timeout_max_seconds
        self._sandbox_timeout_refresh_min_seconds = _env_float("RUNNER_E2B_SANDBOX_TIMEOUT_REFRESH_MIN_SECONDS", 30.0)

    def _touch(self, entry: SessionEntry) -> None:
        now = time.time()
        entry.last_access = now
        entry.last_activity = now

    def _refresh_sandbox_timeout(self, entry: SessionEntry, *, force: bool = False) -> None:
        timeout_seconds = int(self._sandbox_timeout_seconds or 0)
        if timeout_seconds <= 0:
            return
        now = time.time()
        if (
            not force
            and entry.sandbox_timeout_refreshed_at
            and (now - entry.sandbox_timeout_refreshed_at) < self._sandbox_timeout_refresh_min_seconds
        ):
            return
        setter = getattr(entry.sandbox, "set_timeout", None)
        if callable(setter):
            try:
                setter(timeout_seconds)
            except Exception:
                # Best-effort: don't fail the request just because refresh failed.
                pass
        entry.sandbox_timeout_refreshed_at = now

    def _set_status(self, entry: SessionEntry, status: str) -> None:
        entry.status = status
        entry.status_updated_at = time.time()

    def _append_event(self, entry: SessionEntry, event: Dict[str, Any]) -> Dict[str, Any]:
        event["seq"] = entry.next_seq
        entry.next_seq += 1
        entry.events.append(event)
        if len(entry.events) > self._max_events:
            entry.events = entry.events[-self._max_events:]
        return event

    def _update_event(self, entry: SessionEntry, seq: int, patch: Dict[str, Any]) -> None:
        for evt in entry.events:
            if evt.get("seq") == seq:
                evt.update(patch)
                evt["updated_seq"] = entry.next_seq
                entry.next_seq += 1
                return

    def cleanup_expired(self) -> None:
        now = time.time()
        stale: List[str] = []
        with self._lock:
            for sid, entry in self._sessions.items():
                # Optional session keepalive refresh for idle sessions.
                if (
                    self._keepalive_interval_seconds > 0
                    and entry.status in ("idle", "waiting", "running")
                    and (now - entry.last_access) >= self._keepalive_interval_seconds
                ):
                    self._touch(entry)
                    self._refresh_sandbox_timeout(entry)

                # Never reap sessions that are actively running commands/PTY.
                if entry.status == "running":
                    continue
                # Grace period right after create to reduce early "not found" races.
                if self._creation_grace_seconds > 0 and (now - entry.created_at) < self._creation_grace_seconds:
                    continue
                last_activity = entry.last_activity or entry.last_access or entry.created_at
                if now - last_activity > self._ttl:
                    stale.append(sid)
            for sid in stale:
                entry = self._sessions.pop(sid, None)
                if entry:
                    try:
                        entry.sandbox.close()
                    except Exception:
                        pass

    def create(self, workdir: str = "/code") -> SessionEntry:
        if Sandbox is None:
            raise E2BModelRunnerError(get_e2b_import_error())
        with self._lock:
            if len(self._sessions) >= self._max_sessions:
                raise E2BModelRunnerError("Too many active sessions")
            sid = str(uuid.uuid4())
            api_key = (os.getenv("E2B_API_KEY") or "").strip()
            if not api_key:
                raise E2BModelRunnerError("E2B_API_KEY is missing. Set it in the runner service environment.")
            sbx = None
            try:
                sbx = create_e2b_sandbox(int(self._sandbox_timeout_seconds))
                bootstrap_e2b_python_dependencies(sbx)
            except E2BModelRunnerError:
                if sbx is not None:
                    try:
                        sbx.close()
                    except Exception:
                        pass
                raise
            except Exception as exc:
                if sbx is not None:
                    try:
                        sbx.close()
                    except Exception:
                        pass
                raise E2BModelRunnerError(
                    f"Failed to create E2B sandbox. Check E2B_API_KEY and network connectivity. ({type(exc).__name__})"
                ) from exc
            try:
                sbx.files.make_dir(workdir)
            except Exception:
                pass
            now = time.time()
            entry = SessionEntry(
                id=sid,
                sandbox=sbx,
                created_at=now,
                last_access=now,
                last_activity=now,
                workdir=workdir,
            )
            entry.sandbox_timeout_refreshed_at = now
            # Ensure the sandbox lifetime is extended even if the SDK didn't accept `timeout=` at creation time.
            self._refresh_sandbox_timeout(entry, force=True)
            self._set_status(entry, "starting")
            self._append_event(entry, {
                "id": str(uuid.uuid4()),
                "kind": "session",
                "label": "Session created",
                "status": "completed",
                "startedAt": _now_iso(),
                "finishedAt": _now_iso(),
            })
            self._set_status(entry, "idle")
            self._sessions[sid] = entry
            return entry

    def get(self, session_id: str) -> SessionEntry:
        with self._lock:
            entry = self._sessions.get(session_id)
        if not entry:
            raise E2BModelRunnerError("Session not found")
        self._touch(entry)
        self._refresh_sandbox_timeout(entry)
        return entry

    def delete(self, session_id: str) -> None:
        with self._lock:
            entry = self._sessions.pop(session_id, None)
        if entry:
            try:
                entry.sandbox.close()
            except Exception:
                pass

    def status_payload(self, entry: SessionEntry) -> Dict[str, Any]:
        return {
            "session_id": entry.id,
            "status": entry.status,
            "updated_at": datetime.fromtimestamp(entry.status_updated_at, tz=timezone.utc).isoformat(),
            "workdir": entry.workdir,
        }

    def list_events(self, entry: SessionEntry, after: int = 0, limit: int = 200) -> Dict[str, Any]:
        events = [
            e for e in entry.events
            if isinstance(e.get("seq"), int)
            and (e["seq"] > after or (isinstance(e.get("updated_seq"), int) and e["updated_seq"] > after))
        ]
        if limit > 0:
            events = events[:limit]
        max_seq = max(
            (e.get("updated_seq") or e["seq"] for e in events),
            default=after,
        )
        next_after = max(after, max_seq)
        return {"session_id": entry.id, "events": events, "next_after": next_after}


session_manager = SessionManager()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path_has_parent_segment(value: str) -> bool:
    return any(part == ".." for part in value.replace("\\", "/").split("/"))


def _resolve_session_path(entry: SessionEntry, requested_path: Optional[str], *, default_to_workdir: bool = True) -> str:
    base = (entry.workdir or "/code").strip().replace("\\", "/") or "/code"
    if _path_has_parent_segment(base):
        raise E2BModelRunnerError("Session workdir is invalid (contains '..').")
    normalized_base = os.path.normpath(base)

    raw = str(requested_path or "").strip().replace("\\", "/")
    if not raw:
        return normalized_base if default_to_workdir else ""
    if _path_has_parent_segment(raw):
        raise E2BModelRunnerError("Path cannot include '..' segments.")
    if raw.startswith("/"):
        return os.path.normpath(raw)
    normalized_raw = os.path.normpath(raw)
    if normalized_raw == normalized_base:
        return normalized_base
    return os.path.normpath(os.path.join(normalized_base, normalized_raw))


def _to_session_error(exc: Exception) -> E2BModelRunnerError:
    message = str(exc or "").strip()
    lower = message.lower()
    if "sandbox was not found" in lower or "sandbox not found" in lower:
        return E2BModelRunnerError("Sandbox session expired. Start a new sandbox session.")
    if message:
        return E2BModelRunnerError(message)
    return E2BModelRunnerError(type(exc).__name__)


def _iso_from_ts(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()


def _max_stream_chars() -> int:
    return _env_int("RUNNER_MAX_STREAM_BYTES", 120_000)


def _stream_interval_seconds() -> float:
    return _env_int("RUNNER_STREAM_EVENT_INTERVAL_MS", 350) / 1000.0


def _cap_text(value: str, max_chars: int) -> str:
    if max_chars <= 0:
        return value
    if len(value) <= max_chars:
        return value
    return value[-max_chars:]


def _normalize_stream_chunk(data: Any) -> str:
    if data is None:
        return ""
    if isinstance(data, bytes):
        return data.decode("utf-8", errors="replace")
    return str(data)


def _append_stream_text(current: str, chunk: str, max_chars: int) -> str:
    if not chunk:
        return current
    combined = current + chunk
    return _cap_text(combined, max_chars)


def _active_running(entry: SessionEntry) -> bool:
    for state in entry.commands.values():
        if state.status == "running":
            return True
    for state in entry.ptys.values():
        if state.status == "running":
            return True
    return False


def _set_status_after_activity(entry: SessionEntry, failed: bool = False) -> None:
    if failed:
        session_manager._set_status(entry, "failed")
        return
    if _active_running(entry):
        session_manager._set_status(entry, "running")
    else:
        session_manager._set_status(entry, "idle")


def _get_commands(entry: SessionEntry) -> Any:
    commands = getattr(entry.sandbox, "commands", None)
    if commands is None:
        raise E2BModelRunnerError(
            "Sandbox commands API is unavailable. Upgrade e2b-code-interpreter to >=2.0.0."
        )
    return commands


def _get_pty(entry: SessionEntry) -> Any:
    pty = getattr(entry.sandbox, "pty", None)
    if pty is None:
        raise E2BModelRunnerError(
            "Sandbox PTY API is unavailable. Upgrade e2b-code-interpreter to >=2.0.0."
        )
    return pty


def _extract_pid(value: Any) -> Optional[int]:
    if value is None:
        return None
    for attr in ("pid", "process_id", "processId"):
        pid = getattr(value, attr, None)
        if isinstance(pid, int):
            return pid
        try:
            if pid is not None:
                return int(pid)
        except Exception:
            continue
    return None


def _extract_command_outputs(value: Any) -> Tuple[str, str, Optional[int]]:
    stdout = ""
    stderr = ""
    exit_code: Optional[int] = None
    if value is None:
        return stdout, stderr, exit_code
    for attr in ("stdout", "out", "output"):
        if hasattr(value, attr):
            try:
                stdout = str(getattr(value, attr) or "")
                break
            except Exception:
                continue
    for attr in ("stderr", "err"):
        if hasattr(value, attr):
            try:
                stderr = str(getattr(value, attr) or "")
                break
            except Exception:
                continue
    exit_code = getattr(value, "exit_code", None)
    if exit_code is None:
        exit_code = getattr(value, "exitCode", None)
    if exit_code is None and hasattr(value, "returncode"):
        exit_code = getattr(value, "returncode", None)
    try:
        exit_code = int(exit_code) if exit_code is not None else None
    except Exception:
        exit_code = None
    return stdout, stderr, exit_code


def _emit_command_event(entry: SessionEntry, state: CommandState, *, force: bool = False, status_override: Optional[str] = None) -> None:
    now = time.time()
    if state.stream and not force:
        interval = _stream_interval_seconds()
        if interval > 0 and (now - state.last_emit_at) < interval:
            return
    state.last_emit_at = now
    status = status_override or state.status
    event: Dict[str, Any] = {
        "id": state.event_id,
        "kind": "command",
        "label": state.command,
        "status": status,
        "startedAt": _iso_from_ts(state.started_at) or _now_iso(),
        "stdout": state.stdout,
        "stderr": state.stderr,
        "meta": {
            "pid": state.pid,
            "cwd": state.cwd,
            "exit_code": state.exit_code,
            "timed_out": state.timed_out,
        },
    }
    finished_at = _iso_from_ts(state.finished_at)
    if finished_at:
        event["finishedAt"] = finished_at
        event["durationMs"] = int((state.finished_at - state.started_at) * 1000)
    session_manager._append_event(entry, event)


def _emit_pty_event(entry: SessionEntry, state: PtyState, *, force: bool = False, status_override: Optional[str] = None) -> None:
    now = time.time()
    if state.stream and not force:
        interval = _stream_interval_seconds()
        if interval > 0 and (now - state.last_emit_at) < interval:
            return
    state.last_emit_at = now
    status = status_override or state.status
    event: Dict[str, Any] = {
        "id": state.event_id,
        "kind": "pty",
        "label": f"PTY {state.pid}",
        "status": status,
        "startedAt": _iso_from_ts(state.started_at) or _now_iso(),
        "stdout": state.output,
        "meta": {
            "pid": state.pid,
            "cwd": state.cwd,
            "rows": state.rows,
            "cols": state.cols,
        },
    }
    finished_at = _iso_from_ts(state.finished_at)
    if finished_at:
        event["finishedAt"] = finished_at
        event["durationMs"] = int((state.finished_at - state.started_at) * 1000)
    session_manager._append_event(entry, event)


def _append_command_output(entry: SessionEntry, state: CommandState, chunk: Any, is_stderr: bool) -> None:
    text = _normalize_stream_chunk(chunk)
    if not text:
        return
    max_chars = _max_stream_chars()
    with entry.lock:
        if is_stderr:
            state.stderr = _append_stream_text(state.stderr, text, max_chars)
        else:
            state.stdout = _append_stream_text(state.stdout, text, max_chars)
        if state.stream:
            _emit_command_event(entry, state)


def _append_pty_output(entry: SessionEntry, state: PtyState, chunk: Any) -> None:
    text = _normalize_stream_chunk(chunk)
    if not text:
        return
    max_chars = _max_stream_chars()
    with entry.lock:
        state.output = _append_stream_text(state.output, text, max_chars)
        if state.stream:
            _emit_pty_event(entry, state)


def exec_command(
    entry: SessionEntry,
    command: str,
    cwd: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    cwd = _resolve_session_path(entry, cwd)
    if timeout_seconds is None:
        timeout: Optional[int] = _env_int("RUNNER_SESSION_EXEC_TIMEOUT", 30)
    else:
        try:
            timeout = int(timeout_seconds)
        except Exception:
            timeout = _env_int("RUNNER_SESSION_EXEC_TIMEOUT", 30)
    # Treat <= 0 as "no timeout" (subprocess expects timeout=None for unlimited).
    if timeout is not None and timeout <= 0:
        timeout = None
    env = env or {}
    start_time = time.time()
    session_manager._set_status(entry, "running")
    event = session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "exec",
        "label": command,
        "status": "running",
        "startedAt": _now_iso(),
        "meta": {"cwd": cwd},
    })
    marker_exit = "__TUNA_EXIT_CODE__"
    marker_timeout = "__TUNA_TIMED_OUT__"
    payload = {"cmd": command, "cwd": cwd, "timeout": timeout, "env": env}
    run_code_timeout = 0 if timeout is None else max(30, int(timeout) + 15)
    py = f"""
import os, subprocess, sys, json
payload = {json.dumps(payload)}
os.makedirs(payload["cwd"], exist_ok=True)
env = os.environ.copy()
env.update({{k: str(v) for k, v in (payload.get("env") or {{}}).items()}})
timed_out = False
try:
    p = subprocess.run(payload["cmd"], shell=True, text=True, capture_output=True, cwd=payload["cwd"], env=env, timeout=payload["timeout"])
    code = p.returncode
    print(p.stdout, end="")
    print(p.stderr, end="", file=sys.stderr)
except subprocess.TimeoutExpired as e:
    timed_out = True
    code = -1
    if e.stdout:
        print(e.stdout, end="")
    if e.stderr:
        print(e.stderr, end="", file=sys.stderr)
print("{marker_exit}:" + str(code))
print("{marker_timeout}:" + ("1" if timed_out else "0"))
""".strip()
    try:
        with entry.lock:
            execution = entry.sandbox.run_code(py, timeout=run_code_timeout)
    except Exception as exc:
        err = _to_session_error(exc)
        duration_ms = int((time.time() - start_time) * 1000)
        session_manager._update_event(entry, event["seq"], {
            "status": "failed",
            "finishedAt": _now_iso(),
            "durationMs": duration_ms,
            "stderr": str(err),
            "meta": {
                "cwd": cwd,
                "error": str(err),
            },
        })
        session_manager._set_status(entry, "failed")
        if "expired" in str(err).lower():
            session_manager.delete(entry.id)
        raise err from exc
    stdout, stderr = _format_exec_logs(execution)
    exit_code = None
    timed_out = False
    clean_stdout = stdout
    for line in stdout.splitlines():
        if line.startswith(f"{marker_exit}:"):
            try:
                exit_code = int(line.split(":", 1)[1].strip())
            except Exception:
                exit_code = None
        if line.startswith(f"{marker_timeout}:"):
            timed_out = line.split(":", 1)[1].strip() == "1"
    if marker_exit in clean_stdout:
        clean_stdout = "\n".join(
            ln for ln in clean_stdout.splitlines()
            if not (ln.startswith(f"{marker_exit}:") or ln.startswith(f"{marker_timeout}:"))
        ).strip()
    duration_ms = int((time.time() - start_time) * 1000)
    success = exit_code == 0 and not timed_out
    session_manager._update_event(entry, event["seq"], {
        "status": "completed" if success else "failed",
        "finishedAt": _now_iso(),
        "durationMs": duration_ms,
        "stdout": clean_stdout,
        "stderr": stderr.strip(),
        "meta": {
            "cwd": cwd,
            "exit_code": exit_code,
            "timed_out": timed_out,
        },
    })
    session_manager._set_status(entry, "idle" if success else "failed")
    return {
        "stdout": clean_stdout,
        "stderr": stderr.strip(),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_ms": duration_ms,
    }


def _watch_command(entry: SessionEntry, state: CommandState) -> None:
    handle = state.handle
    if handle is None:
        return
    max_chars = _max_stream_chars()
    try:
        result = handle.wait() if hasattr(handle, "wait") else None
        stdout, stderr, exit_code = _extract_command_outputs(result or handle)
        with entry.lock:
            if stdout:
                state.stdout = _append_stream_text(state.stdout, stdout, max_chars)
            if stderr:
                state.stderr = _append_stream_text(state.stderr, stderr, max_chars)
            if exit_code is None:
                exit_code = getattr(handle, "exit_code", None)
            state.exit_code = int(exit_code) if exit_code is not None else state.exit_code
            state.status = "completed" if state.exit_code == 0 else "failed"
            state.finished_at = time.time()
            _emit_command_event(entry, state, force=True)
    except Exception as exc:
        stdout, stderr, exit_code = _extract_command_outputs(exc)
        with entry.lock:
            if stdout:
                state.stdout = _append_stream_text(state.stdout, stdout, max_chars)
            err_text = stderr or str(exc)
            if err_text:
                state.stderr = _append_stream_text(state.stderr, err_text, max_chars)
            if exit_code is not None:
                state.exit_code = exit_code
            state.status = "failed"
            state.finished_at = time.time()
            _emit_command_event(entry, state, force=True, status_override="failed")
    _set_status_after_activity(entry, failed=state.status != "completed")


def _command_timeout_guard(entry: SessionEntry, state: CommandState, timeout_seconds: int) -> None:
    if timeout_seconds <= 0:
        return
    time.sleep(timeout_seconds)
    with entry.lock:
        if state.status != "running":
            return
        state.timed_out = True
    try:
        commands = _get_commands(entry)
        commands.kill(state.pid)
    except Exception:
        pass
    with entry.lock:
        state.status = "failed"
        state.finished_at = time.time()
        _emit_command_event(entry, state, force=True, status_override="failed")
    _set_status_after_activity(entry, failed=True)


def start_command(
    entry: SessionEntry,
    command: str,
    cwd: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    env: Optional[Dict[str, str]] = None,
    *,
    background: bool = False,
    stream: bool = True,
) -> Dict[str, Any]:
    cwd = _resolve_session_path(entry, cwd)
    env = env or {}
    commands = _get_commands(entry)
    timeout = timeout_seconds if timeout_seconds is not None else 0
    start_time = time.time()
    state = CommandState(pid=0, command=command, cwd=cwd, started_at=start_time, stream=stream)
    session_manager._set_status(entry, "running")

    def on_stdout(msg: Any) -> None:
        _append_command_output(entry, state, msg, False)

    def on_stderr(msg: Any) -> None:
        _append_command_output(entry, state, msg, True)

    try:
        result = commands.run(
            cmd=command,
            background=background,
            envs=env,
            cwd=cwd,
            on_stdout=on_stdout,
            on_stderr=on_stderr,
            timeout=timeout,
        )
    except Exception as exc:
        stdout, stderr, exit_code = _extract_command_outputs(exc)
        with entry.lock:
            if stdout:
                state.stdout = _append_stream_text(state.stdout, stdout, _max_stream_chars())
            if stderr:
                state.stderr = _append_stream_text(state.stderr, stderr, _max_stream_chars())
            state.exit_code = exit_code
            state.status = "failed"
            state.finished_at = time.time()
            _emit_command_event(entry, state, force=True, status_override="failed")
        session_manager._set_status(entry, "failed")
        raise _to_session_error(exc)

    if background:
        pid = _extract_pid(result)
        if pid is None:
            with entry.lock:
                state.status = "failed"
                state.finished_at = time.time()
                state.stderr = _append_stream_text(state.stderr, "Background command returned no pid.", _max_stream_chars())
                _emit_command_event(entry, state, force=True, status_override="failed")
            session_manager._set_status(entry, "failed")
            raise E2BModelRunnerError("Background command returned no pid.")
        with entry.lock:
            state.pid = pid
            state.handle = result
            entry.commands[pid] = state
            _emit_command_event(entry, state, force=True, status_override="running")
        watcher = threading.Thread(target=_watch_command, args=(entry, state), daemon=True)
        watcher.start()
        if timeout_seconds is not None and timeout_seconds > 0:
            guard = threading.Thread(target=_command_timeout_guard, args=(entry, state, timeout_seconds), daemon=True)
            guard.start()
        return {"pid": pid, "status": "running"}

    stdout, stderr, exit_code = _extract_command_outputs(result)
    with entry.lock:
        if stdout:
            state.stdout = _append_stream_text(state.stdout, stdout, _max_stream_chars())
        if stderr:
            state.stderr = _append_stream_text(state.stderr, stderr, _max_stream_chars())
        state.exit_code = exit_code
        state.status = "completed" if exit_code == 0 else "failed"
        state.finished_at = time.time()
        _emit_command_event(entry, state, force=True, status_override=state.status)
    _set_status_after_activity(entry, failed=state.status != "completed")
    return {
        "stdout": state.stdout,
        "stderr": state.stderr,
        "exit_code": state.exit_code,
        "timed_out": state.timed_out,
        "duration_ms": int((state.finished_at - state.started_at) * 1000),
    }


def command_status(entry: SessionEntry, pid: int) -> Dict[str, Any]:
    with entry.lock:
        state = entry.commands.get(pid)
    if not state:
        raise E2BModelRunnerError("Command not found")
    if state.status == "running" and state.handle is not None:
        exit_code = getattr(state.handle, "exit_code", None)
        if exit_code is not None:
            with entry.lock:
                state.exit_code = int(exit_code)
                state.status = "completed" if state.exit_code == 0 else "failed"
                state.finished_at = time.time()
                _emit_command_event(entry, state, force=True, status_override=state.status)
            _set_status_after_activity(entry, failed=state.status != "completed")
    return {
        "pid": state.pid,
        "command": state.command,
        "cwd": state.cwd,
        "status": state.status,
        "started_at": _iso_from_ts(state.started_at),
        "finished_at": _iso_from_ts(state.finished_at),
        "stdout": state.stdout,
        "stderr": state.stderr,
        "exit_code": state.exit_code,
        "timed_out": state.timed_out,
    }


def command_send_stdin(entry: SessionEntry, pid: int, data: str) -> Dict[str, Any]:
    commands = _get_commands(entry)
    try:
        commands.send_stdin(pid, data)
    except Exception as exc:
        raise _to_session_error(exc)
    return {"pid": pid, "sent": True}


def command_kill(entry: SessionEntry, pid: int) -> Dict[str, Any]:
    commands = _get_commands(entry)
    killed = False
    try:
        killed = bool(commands.kill(pid))
    except Exception as exc:
        raise _to_session_error(exc)
    with entry.lock:
        state = entry.commands.get(pid)
        if state:
            state.status = "cancelled" if killed else state.status
            state.finished_at = time.time()
            _emit_command_event(entry, state, force=True, status_override=state.status)
    _set_status_after_activity(entry, failed=not killed)
    return {"pid": pid, "killed": killed}


def _watch_pty(entry: SessionEntry, state: PtyState) -> None:
    handle = state.handle
    if handle is None:
        return
    try:
        if hasattr(handle, "wait"):
            handle.wait()
    except Exception as exc:
        with entry.lock:
            state.output = _append_stream_text(state.output, str(exc), _max_stream_chars())
            state.status = "failed"
            state.finished_at = time.time()
            _emit_pty_event(entry, state, force=True, status_override="failed")
        _set_status_after_activity(entry, failed=True)
        return
    with entry.lock:
        state.status = "completed"
        state.finished_at = time.time()
        _emit_pty_event(entry, state, force=True, status_override="completed")
    _set_status_after_activity(entry, failed=False)


def _build_pty_size(pty: Any, rows: int, cols: int) -> Any:
    size_cls = getattr(pty, "PtySize", None)
    if size_cls is None:
        size_cls = globals().get("PtySize")
    if size_cls:
        try:
            return size_cls(rows=rows, cols=cols)
        except Exception:
            pass
    return {"rows": rows, "cols": cols}


def create_pty(
    entry: SessionEntry,
    rows: int,
    cols: int,
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    timeout_seconds: Optional[int] = None,
    *,
    stream: bool = True,
) -> Dict[str, Any]:
    cwd = _resolve_session_path(entry, cwd)
    env = env or {}
    pty = _get_pty(entry)
    # Default to no timeout; clients can pass `timeout_seconds` to limit.
    timeout = timeout_seconds if timeout_seconds is not None else 0
    start_time = time.time()
    state = PtyState(pid=0, rows=rows, cols=cols, cwd=cwd, started_at=start_time, stream=stream)
    session_manager._set_status(entry, "running")

    def on_data(chunk: Any) -> None:
        _append_pty_output(entry, state, chunk)

    size = _build_pty_size(pty, rows, cols)
    try:
        handle = pty.create(
            size=size,
            on_data=on_data,
            cwd=cwd,
            envs=env,
            timeout=timeout,
        )
    except Exception as exc:
        with entry.lock:
            state.status = "failed"
            state.finished_at = time.time()
            state.output = _append_stream_text(state.output, str(exc), _max_stream_chars())
            _emit_pty_event(entry, state, force=True, status_override="failed")
        session_manager._set_status(entry, "failed")
        raise _to_session_error(exc)

    pid = _extract_pid(handle)
    if pid is None:
        with entry.lock:
            state.status = "failed"
            state.finished_at = time.time()
            state.output = _append_stream_text(state.output, "PTY creation returned no pid.", _max_stream_chars())
            _emit_pty_event(entry, state, force=True, status_override="failed")
        session_manager._set_status(entry, "failed")
        raise E2BModelRunnerError("PTY creation returned no pid.")

    with entry.lock:
        state.pid = pid
        state.handle = handle
        entry.ptys[pid] = state
        _emit_pty_event(entry, state, force=True, status_override="running")

    watcher = threading.Thread(target=_watch_pty, args=(entry, state), daemon=True)
    watcher.start()

    return {"pid": pid, "rows": rows, "cols": cols}


def pty_send(entry: SessionEntry, pid: int, data: str) -> Dict[str, Any]:
    pty = _get_pty(entry)
    payload = data.encode("utf-8") if isinstance(data, str) else data
    try:
        pty.send_stdin(pid, payload)
    except Exception as exc:
        raise _to_session_error(exc)
    return {"pid": pid, "sent": True}


def pty_resize(entry: SessionEntry, pid: int, rows: int, cols: int) -> Dict[str, Any]:
    pty = _get_pty(entry)
    size = _build_pty_size(pty, rows, cols)
    try:
        pty.resize(pid, size)
    except Exception as exc:
        raise _to_session_error(exc)
    with entry.lock:
        state = entry.ptys.get(pid)
        if state:
            state.rows = rows
            state.cols = cols
            _emit_pty_event(entry, state, force=True, status_override=state.status)
    return {"pid": pid, "rows": rows, "cols": cols}


def pty_kill(entry: SessionEntry, pid: int) -> Dict[str, Any]:
    pty = _get_pty(entry)
    killed = False
    try:
        killed = bool(pty.kill(pid))
    except Exception as exc:
        raise _to_session_error(exc)
    with entry.lock:
        state = entry.ptys.get(pid)
        if state:
            state.status = "cancelled" if killed else state.status
            state.finished_at = time.time()
            _emit_pty_event(entry, state, force=True, status_override=state.status)
    _set_status_after_activity(entry, failed=not killed)
    return {"pid": pid, "killed": killed}


def pty_status(entry: SessionEntry, pid: int, after: int = 0) -> Dict[str, Any]:
    with entry.lock:
        state = entry.ptys.get(pid)
        if not state:
            raise E2BModelRunnerError("PTY not found")
        output = state.output
        total_len = len(output)
    if after > 0:
        output = output[after:] if after < total_len else ""
    return {
        "pid": pid,
        "status": state.status,
        "rows": state.rows,
        "cols": state.cols,
        "cwd": state.cwd,
        "started_at": _iso_from_ts(state.started_at),
        "finished_at": _iso_from_ts(state.finished_at),
        "output": output,
        "next_after": total_len,
    }


def write_files(entry: SessionEntry, files: List[Dict[str, Any]]) -> Dict[str, Any]:
    max_bytes = _env_int("RUNNER_MAX_FILE_BYTES", 20_000_000)
    written: List[str] = []
    start_time = time.time()
    session_manager._set_status(entry, "uploading")
    event = session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "upload",
        "label": f"{len(files)} file(s)",
        "status": "running",
        "startedAt": _now_iso(),
    })
    try:
        with entry.lock:
            for f in files:
                raw_path = str(f.get("path") or "").strip()
                if not raw_path:
                    continue
                target_path = _resolve_session_path(entry, raw_path)
                if "content_base64" in f:
                    raw = str(f.get("content_base64") or "")
                    data = base64.b64decode(raw.encode("utf-8"))
                else:
                    text = str(f.get("content_text") or "")
                    data = text
                if isinstance(data, (bytes, bytearray)) and len(data) > max_bytes:
                    raise E2BModelRunnerError("File too large for upload")
                entry.sandbox.files.write(target_path, data)
                written.append(target_path)
    except Exception as exc:
        err = exc if isinstance(exc, E2BModelRunnerError) else _to_session_error(exc)
        session_manager._update_event(entry, event["seq"], {
            "status": "failed",
            "finishedAt": _now_iso(),
            "meta": {"error": str(err), "paths": written},
        })
        session_manager._set_status(entry, "failed")
        raise err
    duration_ms = int((time.time() - start_time) * 1000)
    session_manager._update_event(entry, event["seq"], {
        "status": "completed",
        "finishedAt": _now_iso(),
        "durationMs": duration_ms,
        "meta": {"paths": written},
    })
    session_manager._set_status(entry, "idle")
    return {"written": written}


def list_files(entry: SessionEntry, path: Optional[str]) -> List[Dict[str, Any]]:
    target_path = _resolve_session_path(entry, path)
    session_manager._set_status(entry, "waiting")
    event = session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "list_files",
        "label": target_path,
        "status": "running",
        "startedAt": _now_iso(),
    })
    try:
        with entry.lock:
            entries = entry.sandbox.files.list(target_path)
    except Exception as exc:
        err = exc if isinstance(exc, E2BModelRunnerError) else _to_session_error(exc)
        session_manager._update_event(entry, event["seq"], {
            "status": "failed",
            "finishedAt": _now_iso(),
            "meta": {"error": str(err)},
        })
        session_manager._set_status(entry, "failed")
        raise err
    out = []
    for e in entries:
        out.append({
            "name": getattr(e, "name", None),
            "path": getattr(e, "path", None),
            "type": str(getattr(e, "type", "")),
            "size": getattr(e, "size", None),
        })
    session_manager._update_event(entry, event["seq"], {
        "status": "completed",
        "finishedAt": _now_iso(),
        "meta": {"count": len(out)},
    })
    session_manager._set_status(entry, "idle")
    return out


def read_file(entry: SessionEntry, path: str) -> bytes:
    max_bytes = _env_int("RUNNER_MAX_FILE_BYTES", 20_000_000)
    target_path = _resolve_session_path(entry, path)
    session_manager._set_status(entry, "waiting")
    event = session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "download",
        "label": target_path,
        "status": "running",
        "startedAt": _now_iso(),
    })
    try:
        with entry.lock:
            data = entry.sandbox.files.read(target_path)
    except Exception as exc:
        err = exc if isinstance(exc, E2BModelRunnerError) else _to_session_error(exc)
        session_manager._update_event(entry, event["seq"], {
            "status": "failed",
            "finishedAt": _now_iso(),
            "meta": {"error": str(err)},
        })
        session_manager._set_status(entry, "failed")
        raise err
    if isinstance(data, str):
        data_bytes = data.encode("utf-8")
    else:
        data_bytes = data
    if len(data_bytes) > max_bytes:
        session_manager._update_event(entry, event["seq"], {
            "status": "failed",
            "finishedAt": _now_iso(),
            "meta": {"error": "File too large"},
        })
        session_manager._set_status(entry, "failed")
        raise E2BModelRunnerError("File too large to download")
    session_manager._update_event(entry, event["seq"], {
        "status": "completed",
        "finishedAt": _now_iso(),
        "meta": {"bytes": len(data_bytes)},
    })
    session_manager._set_status(entry, "idle")
    return data_bytes


def _ensure_playwright(entry: SessionEntry) -> None:
    if entry.browser_ready:
        return
    py = """
import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "playwright"], check=True)
subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True)
""".strip()
    with entry.lock:
        entry.sandbox.run_code(py)
    entry.browser_ready = True


def run_browser_action(entry: SessionEntry, payload: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_playwright(entry)
    marker = "__TUNA_BROWSER__"
    session_manager._set_status(entry, "waiting")
    event = session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "browser",
        "label": payload.get("url") or "browser",
        "status": "running",
        "startedAt": _now_iso(),
        "meta": {"action": payload.get("action")},
    })
    py = f"""
import json, base64
from playwright.sync_api import sync_playwright
payload = {json.dumps(payload)}
result = {{}}
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport=payload.get("viewport"))
    page.goto(payload["url"], wait_until="load")
    wait_ms = payload.get("wait_ms")
    if wait_ms:
        page.wait_for_timeout(int(wait_ms))
    action = payload.get("action", "screenshot")
    selector = payload.get("selector")
    if action == "html":
        result["html"] = page.content()
    elif action == "text":
        if selector:
            result["text"] = page.locator(selector).inner_text()
        else:
            result["text"] = page.inner_text("body")
    else:
        data = page.screenshot(full_page=True)
        result["screenshot_base64"] = base64.b64encode(data).decode("utf-8")
    browser.close()
print("{marker}" + json.dumps({{"ok": True, "action": action, "url": payload["url"], "result": result}}))
""".strip()
    with entry.lock:
        execution = entry.sandbox.run_code(py)
    stdout, stderr = _format_exec_logs(execution)
    for line in stdout.splitlines():
        if line.startswith(marker):
            try:
                result = json.loads(line[len(marker):])
                session_manager._update_event(entry, event["seq"], {
                    "status": "completed",
                    "finishedAt": _now_iso(),
                })
                session_manager._set_status(entry, "idle")
                return result
            except Exception:
                break
    session_manager._update_event(entry, event["seq"], {
        "status": "failed",
        "finishedAt": _now_iso(),
        "stderr": stderr.strip(),
    })
    session_manager._set_status(entry, "failed")
    return {"ok": False, "error": stderr.strip() or "Browser action failed"}
