"""
In-memory E2B desktop sessions for interactive desktop actions/screenshot.
Sessions are ephemeral and cleaned up via TTL.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from runner import E2BModelRunnerError
from storage import create_signed_url, upload_bytes

try:
    from e2b_desktop import Sandbox as DesktopSandbox
    if not getattr(DesktopSandbox, "create", None):
        raise ImportError(
            "e2b_desktop.Sandbox has no 'create' method. "
            "Upgrade with: pip install 'e2b-desktop>=2.0.0'"
        )
except ImportError as e:
    DesktopSandbox = None  # type: ignore
    _DESKTOP_IMPORT_ERROR = str(e)
except Exception as e:
    DesktopSandbox = None  # type: ignore
    _DESKTOP_IMPORT_ERROR = f"e2b_desktop: {e}. Try: pip install 'e2b-desktop>=2.0.0'"


def get_desktop_import_error() -> str:
    err = globals().get("_DESKTOP_IMPORT_ERROR")
    if err:
        return str(err)
    return "e2b_desktop not installed or incompatible. Install with: pip install 'e2b-desktop>=2.0.0'"


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


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if raw in ("1", "true", "yes", "y", "on"):
        return True
    if raw in ("0", "false", "no", "n", "off"):
        return False
    return default


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_from_ts(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
    except Exception:
        return None


def _clamp(value: int, min_value: int, max_value: int) -> int:
    return max(min_value, min(max_value, value))


def _normalize_resolution(resolution: Optional[Tuple[int, int]]) -> Optional[Tuple[int, int]]:
    if resolution is None:
        return None
    width, height = resolution
    min_w = _env_int("RUNNER_DESKTOP_MIN_WIDTH", 640)
    max_w = _env_int("RUNNER_DESKTOP_MAX_WIDTH", 1920)
    min_h = _env_int("RUNNER_DESKTOP_MIN_HEIGHT", 480)
    max_h = _env_int("RUNNER_DESKTOP_MAX_HEIGHT", 1080)
    width = _clamp(int(width), min_w, max_w)
    height = _clamp(int(height), min_h, max_h)
    return width, height


def _normalize_dpi(dpi: Optional[int]) -> Optional[int]:
    if dpi is None:
        return None
    min_dpi = _env_int("RUNNER_DESKTOP_MIN_DPI", 72)
    max_dpi = _env_int("RUNNER_DESKTOP_MAX_DPI", 160)
    return _clamp(int(dpi), min_dpi, max_dpi)


def _close_desktop_sandbox(sandbox: Any) -> None:
    for method in ("kill", "close"):
        fn = getattr(sandbox, method, None)
        if callable(fn):
            try:
                fn()
            except Exception:
                pass
            return


def _recording_interval_ms() -> int:
    return _env_int("RUNNER_DESKTOP_RECORD_INTERVAL_MS", 1000)


def _recording_max_frames() -> int:
    return _env_int("RUNNER_DESKTOP_RECORD_MAX_FRAMES", 600)


def _recording_signed_url_ttl() -> int:
    return _env_int("RUNNER_DESKTOP_RECORD_URL_TTL", 600)


def _recording_manifest_key(session_id: str) -> str:
    return f"desktop/{session_id}/recording/manifest.json"


def _recording_frame_key(session_id: str, seq: int) -> str:
    return f"desktop/{session_id}/recording/frames/{seq:06d}.png"


def _normalize_bytes(data: Any) -> bytes:
    if isinstance(data, bytearray):
        return bytes(data)
    if isinstance(data, bytes):
        return data
    if isinstance(data, str):
        return data.encode("utf-8")
    return bytes(data)


@dataclass
class DesktopSessionEntry:
    id: str
    sandbox: Any
    created_at: float
    last_access: float
    last_activity: float
    status: str = "starting"
    status_updated_at: float = field(default_factory=time.time)
    events: List[Dict[str, Any]] = field(default_factory=list)
    next_seq: int = 1
    lock: threading.Lock = field(default_factory=threading.Lock)
    resolution: Optional[Tuple[int, int]] = None
    dpi: Optional[int] = None
    display: Optional[str] = None
    stream_active: bool = False
    stream_auth_key: Optional[str] = None
    stream_require_auth: bool = True
    stream_window_id: Optional[str] = None
    stream_started_at: Optional[float] = None
    recording_active: bool = False
    recording_started_at: Optional[float] = None
    recording_stopped_at: Optional[float] = None
    recording_interval_ms: Optional[int] = None
    recording_frames: List[Dict[str, Any]] = field(default_factory=list)
    recording_manifest_key: Optional[str] = None
    recording_error: Optional[str] = None
    recording_max_frames: Optional[int] = None
    recording_truncated: bool = False
    recording_thread: Optional[threading.Thread] = field(default=None, repr=False, compare=False)
    recording_stop_event: threading.Event = field(default_factory=threading.Event, repr=False, compare=False)


class DesktopSessionManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, DesktopSessionEntry] = {}
        self._ttl = _env_float(
            "RUNNER_DESKTOP_TTL_SECONDS",
            _env_float("RUNNER_SESSION_TTL_SECONDS", 1800.0),
        )
        self._max_sessions = _env_int(
            "RUNNER_MAX_DESKTOP_SESSIONS",
            _env_int("RUNNER_MAX_SESSIONS", 32),
        )
        self._max_events = _env_int(
            "RUNNER_DESKTOP_MAX_EVENTS",
            _env_int("RUNNER_MAX_EVENTS", 500),
        )

    def _touch(self, entry: DesktopSessionEntry) -> None:
        now = time.time()
        entry.last_access = now
        entry.last_activity = now

    def _set_status(self, entry: DesktopSessionEntry, status: str) -> None:
        entry.status = status
        entry.status_updated_at = time.time()

    def _append_event(self, entry: DesktopSessionEntry, event: Dict[str, Any]) -> Dict[str, Any]:
        event["seq"] = entry.next_seq
        entry.next_seq += 1
        entry.events.append(event)
        if len(entry.events) > self._max_events:
            entry.events = entry.events[-self._max_events:]
        return event

    def _update_event(self, entry: DesktopSessionEntry, seq: int, patch: Dict[str, Any]) -> None:
        for evt in entry.events:
            if evt.get("seq") == seq:
                evt.update(patch)
                return

    def cleanup_expired(self) -> None:
        now = time.time()
        stale: List[str] = []
        with self._lock:
            for sid, entry in self._sessions.items():
                last_activity = entry.last_activity or entry.last_access or entry.created_at
                if now - last_activity > self._ttl:
                    stale.append(sid)
            for sid in stale:
                entry = self._sessions.pop(sid, None)
                if entry:
                    _stop_recording(entry)
                    _close_desktop_sandbox(entry.sandbox)

    def create(
        self,
        resolution: Optional[Tuple[int, int]] = None,
        dpi: Optional[int] = None,
        display: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> DesktopSessionEntry:
        if DesktopSandbox is None:
            raise E2BModelRunnerError(get_desktop_import_error())
        with self._lock:
            if len(self._sessions) >= self._max_sessions:
                raise E2BModelRunnerError("Too many active desktop sessions")
            sid = str(uuid.uuid4())
            api_key = (os.getenv("E2B_API_KEY") or "").strip()
            if not api_key:
                raise E2BModelRunnerError("E2B_API_KEY is missing. Set it in the runner service environment.")
            template = (os.getenv("RUNNER_DESKTOP_TEMPLATE") or "").strip() or None
            allow_internet = _env_bool("RUNNER_DESKTOP_ALLOW_INTERNET", True)
            normalized_resolution = _normalize_resolution(resolution)
            normalized_dpi = _normalize_dpi(dpi)
            try:
                sbx = DesktopSandbox.create(
                    template=template,
                    resolution=normalized_resolution,
                    dpi=normalized_dpi,
                    display=display,
                    timeout=timeout_seconds,
                    envs=env,
                    allow_internet_access=allow_internet,
                )
            except Exception as exc:
                raise E2BModelRunnerError(
                    f"Failed to create desktop sandbox. Check E2B_API_KEY and network connectivity. ({type(exc).__name__})"
                ) from exc
            now = time.time()
            entry = DesktopSessionEntry(
                id=sid,
                sandbox=sbx,
                created_at=now,
                last_access=now,
                last_activity=now,
                resolution=normalized_resolution,
                dpi=normalized_dpi,
                display=display,
            )
            self._set_status(entry, "starting")
            self._append_event(entry, {
                "id": str(uuid.uuid4()),
                "kind": "desktop",
                "label": "Desktop session created",
                "status": "completed",
                "startedAt": _now_iso(),
                "finishedAt": _now_iso(),
            })
            self._set_status(entry, "running")
            self._sessions[sid] = entry
            return entry

    def get(self, session_id: str) -> DesktopSessionEntry:
        with self._lock:
            entry = self._sessions.get(session_id)
        if not entry:
            raise E2BModelRunnerError("Desktop session not found")
        self._touch(entry)
        return entry

    def delete(self, session_id: str) -> None:
        with self._lock:
            entry = self._sessions.pop(session_id, None)
        if entry:
            _stop_recording(entry)
            _close_desktop_sandbox(entry.sandbox)

    def status_payload(self, entry: DesktopSessionEntry) -> Dict[str, Any]:
        return {
            "desktop_session_id": entry.id,
            "status": entry.status,
            "updated_at": datetime.fromtimestamp(entry.status_updated_at, tz=timezone.utc).isoformat(),
            "resolution": entry.resolution,
            "dpi": entry.dpi,
            "display": entry.display,
            "stream_active": entry.stream_active,
            "stream_started_at": datetime.fromtimestamp(entry.stream_started_at, tz=timezone.utc).isoformat()
            if entry.stream_started_at
            else None,
            "recording": {
                "status": "recording" if entry.recording_active else "stopped",
                "started_at": _iso_from_ts(entry.recording_started_at),
                "stopped_at": _iso_from_ts(entry.recording_stopped_at),
                "interval_ms": entry.recording_interval_ms,
                "frame_count": len(entry.recording_frames),
                "truncated": entry.recording_truncated,
                "error": entry.recording_error,
                "manifest_key": entry.recording_manifest_key,
            },
        }

    def list_events(self, entry: DesktopSessionEntry, after: int = 0, limit: int = 200) -> Dict[str, Any]:
        events = [e for e in entry.events if isinstance(e.get("seq"), int) and e["seq"] > after]
        if limit > 0:
            events = events[:limit]
        next_after = events[-1]["seq"] if events else after
        return {"desktop_session_id": entry.id, "events": events, "next_after": next_after}


desktop_session_manager = DesktopSessionManager()


def _finalize_recording(entry: DesktopSessionEntry) -> None:
    if not entry.recording_manifest_key:
        entry.recording_manifest_key = _recording_manifest_key(entry.id)
    payload = {
        "desktop_session_id": entry.id,
        "status": "stopped" if entry.recording_stopped_at else "recording",
        "started_at": _iso_from_ts(entry.recording_started_at),
        "stopped_at": _iso_from_ts(entry.recording_stopped_at),
        "interval_ms": entry.recording_interval_ms,
        "frame_count": len(entry.recording_frames),
        "truncated": entry.recording_truncated,
        "error": entry.recording_error,
        "frames": entry.recording_frames,
    }
    try:
        upload_bytes(
            entry.recording_manifest_key,
            json.dumps(payload).encode("utf-8"),
            content_type="application/json",
        )
    except Exception as exc:
        entry.recording_error = str(exc)


def _start_recording(entry: DesktopSessionEntry) -> None:
    if entry.recording_active:
        return
    entry.recording_active = True
    entry.recording_started_at = time.time()
    entry.recording_stopped_at = None
    entry.recording_interval_ms = _recording_interval_ms()
    entry.recording_manifest_key = _recording_manifest_key(entry.id)
    entry.recording_error = None
    entry.recording_frames = []
    entry.recording_max_frames = _recording_max_frames()
    entry.recording_truncated = False
    entry.recording_stop_event = threading.Event()
    session_manager = desktop_session_manager
    session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "desktop_recording",
        "label": "Recording started",
        "status": "completed",
        "startedAt": _now_iso(),
        "finishedAt": _now_iso(),
        "meta": {"interval_ms": entry.recording_interval_ms},
    })

    def _loop() -> None:
        seq = 0
        interval = max(0.1, (entry.recording_interval_ms or 1000) / 1000.0)
        max_frames = entry.recording_max_frames or _recording_max_frames()
        try:
            while not entry.recording_stop_event.is_set():
                seq += 1
                try:
                    with entry.lock:
                        data = entry.sandbox.screenshot()
                except Exception as exc:
                    entry.recording_error = str(exc)
                    break
                try:
                    frame_bytes = _normalize_bytes(data)
                    key = _recording_frame_key(entry.id, seq)
                    upload_bytes(key, frame_bytes, content_type="image/png")
                except Exception as exc:
                    entry.recording_error = str(exc)
                    break
                frame = {
                    "seq": seq,
                    "at": _now_iso(),
                    "key": key,
                }
                with entry.lock:
                    entry.recording_frames.append(frame)
                if seq >= max_frames:
                    entry.recording_truncated = True
                    break
                if entry.recording_stop_event.wait(interval):
                    break
        finally:
            entry.recording_active = False
            entry.recording_stopped_at = time.time()
            _finalize_recording(entry)
            session_manager._append_event(entry, {
                "id": str(uuid.uuid4()),
                "kind": "desktop_recording",
                "label": "Recording stopped",
                "status": "completed" if not entry.recording_error else "failed",
                "startedAt": _now_iso(),
                "finishedAt": _now_iso(),
                "meta": {
                    "frame_count": len(entry.recording_frames),
                    "truncated": entry.recording_truncated,
                    "error": entry.recording_error,
                },
            })

    thread = threading.Thread(target=_loop, name=f"desktop-record-{entry.id}", daemon=True)
    entry.recording_thread = thread
    thread.start()


def _stop_recording(entry: DesktopSessionEntry) -> None:
    if not entry.recording_active:
        if entry.recording_stopped_at is None and entry.recording_frames:
            entry.recording_stopped_at = time.time()
            _finalize_recording(entry)
        return
    entry.recording_stop_event.set()
    thread = entry.recording_thread
    if thread and thread.is_alive():
        thread.join(timeout=1.0)


def get_recording_payload(
    entry: DesktopSessionEntry,
    after: int = 0,
    limit: int = 200,
) -> Dict[str, Any]:
    frames = []
    with entry.lock:
        all_frames = entry.recording_frames[:]
    for frame in all_frames:
        seq = frame.get("seq")
        if isinstance(seq, int) and seq > after:
            frames.append(frame)
    if limit > 0:
        frames = frames[:limit]
    next_after = frames[-1]["seq"] if frames else after
    ttl = _recording_signed_url_ttl()
    out_frames = []
    for frame in frames:
        key = frame.get("key")
        url = None
        if isinstance(key, str) and key:
            try:
                url = create_signed_url(key, ttl)
            except Exception:
                url = None
        out_frames.append({**frame, "url": url})
    return {
        "desktop_session_id": entry.id,
        "recording": {
            "status": "recording" if entry.recording_active else "stopped",
            "started_at": _iso_from_ts(entry.recording_started_at),
            "stopped_at": _iso_from_ts(entry.recording_stopped_at),
            "interval_ms": entry.recording_interval_ms,
            "frame_count": len(entry.recording_frames),
            "truncated": entry.recording_truncated,
            "error": entry.recording_error,
            "manifest_key": entry.recording_manifest_key,
            "frames": out_frames,
        },
        "next_after": next_after,
    }


def _action_params(action: Dict[str, Any]) -> Dict[str, Any]:
    raw = action.get("params")
    params: Dict[str, Any] = raw if isinstance(raw, dict) else {}
    # Fold any top-level keys into params so callers can send either:
    # - { action: "...", params: { ... } }  (preferred)
    # - { action: "...", x: 1, y: 2, ... } (legacy / convenience)
    extras: Dict[str, Any] = {}
    for key, value in action.items():
        if key in ("action", "type", "params"):
            continue
        extras[key] = value
    if not extras:
        return params
    return {**extras, **params}


def _run_action(entry: DesktopSessionEntry, action: Dict[str, Any]) -> str:
    name = str(action.get("action") or action.get("type") or "").strip().lower()
    params = _action_params(action)
    sbx = entry.sandbox
    if not name:
        raise E2BModelRunnerError("Action name is required")

    if name in ("click", "left_click"):
        x = params.get("x")
        y = params.get("y")
        if x is None or y is None:
            sbx.left_click()
        else:
            sbx.left_click(x=int(x), y=int(y))
        return "left_click"
    if name == "double_click":
        x = params.get("x")
        y = params.get("y")
        if x is None or y is None:
            sbx.double_click()
        else:
            sbx.double_click(x=int(x), y=int(y))
        return "double_click"
    if name in ("right_click", "middle_click"):
        x = params.get("x")
        y = params.get("y")
        fn = getattr(sbx, name, None)
        if not callable(fn):
            raise E2BModelRunnerError(f"Desktop sandbox does not support {name}")
        if x is None or y is None:
            fn()
        else:
            fn(x=int(x), y=int(y))
        return name
    if name == "scroll":
        direction = params.get("direction")
        amount = params.get("amount")
        delta = params.get("delta")
        if amount is None and delta is not None:
            amount = delta
        if amount is None:
            amount = 1
        try:
            sbx.scroll(direction=direction or "down", amount=int(abs(amount)))
        except TypeError:
            sbx.scroll(int(amount))
        return "scroll"
    if name == "move_mouse":
        x = params.get("x")
        y = params.get("y")
        if x is None or y is None:
            raise E2BModelRunnerError("move_mouse requires x and y")
        sbx.move_mouse(int(x), int(y))
        return "move_mouse"
    if name == "drag":
        fr = params.get("from")
        to = params.get("to")
        if not (isinstance(fr, (list, tuple)) and isinstance(to, (list, tuple)) and len(fr) == 2 and len(to) == 2):
            raise E2BModelRunnerError("drag requires from/to coordinates")
        sbx.drag((int(fr[0]), int(fr[1])), (int(to[0]), int(to[1])))
        return "drag"
    if name == "write":
        text = params.get("text")
        if text is None:
            raise E2BModelRunnerError("write requires text")
        chunk_size = params.get("chunk_size")
        delay = params.get("delay_in_ms") or params.get("delay_ms")
        kwargs: Dict[str, Any] = {}
        if chunk_size is not None:
            kwargs["chunk_size"] = int(chunk_size)
        if delay is not None:
            kwargs["delay_in_ms"] = int(delay)
        sbx.write(str(text), **kwargs)
        return "write"
    if name == "press":
        key = params.get("key")
        keys = params.get("keys")
        if key is None and keys is None:
            raise E2BModelRunnerError("press requires key or keys")
        sbx.press(keys if keys is not None else key)
        return "press"
    if name == "open":
        target = params.get("target") or params.get("file_or_url")
        if not target:
            raise E2BModelRunnerError("open requires target")
        sbx.open(str(target))
        return "open"
    if name == "launch":
        application = params.get("application") or params.get("app")
        if not application:
            raise E2BModelRunnerError("launch requires application")
        uri = params.get("uri")
        if uri:
            sbx.launch(str(application), uri=str(uri))
        else:
            sbx.launch(str(application))
        return "launch"
    if name == "wait":
        ms = params.get("ms") or params.get("duration_ms")
        if ms is None:
            raise E2BModelRunnerError("wait requires ms")
        sbx.wait(int(ms))
        return "wait"

    raise E2BModelRunnerError(f"Unsupported desktop action: {name}")


def run_actions(entry: DesktopSessionEntry, actions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    session_manager = desktop_session_manager
    session_manager._set_status(entry, "running")
    results: List[Dict[str, Any]] = []
    for action in actions:
        label = str(action.get("action") or action.get("type") or "action")
        event = session_manager._append_event(entry, {
            "id": str(uuid.uuid4()),
            "kind": "desktop_action",
            "label": label,
            "status": "running",
            "startedAt": _now_iso(),
            "meta": _action_params(action),
        })
        try:
            with entry.lock:
                performed = _run_action(entry, action)
            session_manager._update_event(entry, event["seq"], {
                "status": "completed",
                "finishedAt": _now_iso(),
                "meta": {**_action_params(action), "performed": performed},
            })
            results.append({"action": performed, "ok": True})
        except Exception as exc:
            err = exc if isinstance(exc, E2BModelRunnerError) else E2BModelRunnerError(str(exc))
            session_manager._update_event(entry, event["seq"], {
                "status": "failed",
                "finishedAt": _now_iso(),
                "meta": {**_action_params(action), "error": str(err)},
            })
            session_manager._set_status(entry, "failed")
            raise err
    session_manager._set_status(entry, "running")
    return results


def take_screenshot(entry: DesktopSessionEntry) -> bytes:
    session_manager = desktop_session_manager
    session_manager._set_status(entry, "waiting")
    event = session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "desktop_screenshot",
        "label": "screenshot",
        "status": "running",
        "startedAt": _now_iso(),
    })
    try:
        with entry.lock:
            data = entry.sandbox.screenshot()
    except Exception as exc:
        err = exc if isinstance(exc, E2BModelRunnerError) else E2BModelRunnerError(str(exc))
        session_manager._update_event(entry, event["seq"], {
            "status": "failed",
            "finishedAt": _now_iso(),
            "meta": {"error": str(err)},
        })
        session_manager._set_status(entry, "failed")
        raise err
    if isinstance(data, bytearray):
        data = bytes(data)
    if isinstance(data, str):
        data = data.encode("utf-8")
    session_manager._update_event(entry, event["seq"], {
        "status": "completed",
        "finishedAt": _now_iso(),
        "meta": {"bytes": len(data)},
    })
    session_manager._set_status(entry, "running")
    return data


def start_stream(entry: DesktopSessionEntry, window_id: Optional[str] = None, require_auth: bool = True) -> Dict[str, Any]:
    session_manager = desktop_session_manager
    stream = getattr(entry.sandbox, "stream", None)
    if not stream:
        raise E2BModelRunnerError("Desktop streaming is not available in this SDK version.")
    session_manager._set_status(entry, "running")
    with entry.lock:
        try:
            stream.start(window_id=window_id, require_auth=require_auth)
        except TypeError:
            # Older SDKs may not support require_auth argument
            stream.start(window_id=window_id)
            require_auth = False
        auth_key = None
        if require_auth:
            try:
                auth_key = stream.get_auth_key()
            except Exception:
                auth_key = None
        try:
            url = stream.get_url(auth_key=auth_key) if auth_key else stream.get_url()
        except Exception as exc:
            raise E2BModelRunnerError(str(exc))
        entry.stream_active = True
        entry.stream_require_auth = require_auth
        entry.stream_auth_key = auth_key
        entry.stream_window_id = window_id
        entry.stream_started_at = time.time()
    _start_recording(entry)
    session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "desktop_stream",
        "label": "Stream started",
        "status": "completed",
        "startedAt": _now_iso(),
        "finishedAt": _now_iso(),
        "meta": {"window_id": window_id, "require_auth": require_auth},
    })
    return {
        "url": url,
        "auth_key": auth_key,
        "window_id": window_id,
        "require_auth": require_auth,
        "recording": {
            "status": "recording" if entry.recording_active else "stopped",
            "started_at": _iso_from_ts(entry.recording_started_at),
            "interval_ms": entry.recording_interval_ms,
            "frame_count": len(entry.recording_frames),
            "manifest_key": entry.recording_manifest_key,
        },
    }


def get_stream_url(entry: DesktopSessionEntry) -> Dict[str, Any]:
    stream = getattr(entry.sandbox, "stream", None)
    if not stream:
        raise E2BModelRunnerError("Desktop streaming is not available in this SDK version.")
    with entry.lock:
        auth_key = entry.stream_auth_key if entry.stream_require_auth else None
        try:
            url = stream.get_url(auth_key=auth_key) if auth_key else stream.get_url()
        except Exception as exc:
            raise E2BModelRunnerError(str(exc))
    return {
        "url": url,
        "auth_key": auth_key,
        "window_id": entry.stream_window_id,
        "require_auth": entry.stream_require_auth,
    }


def stop_stream(entry: DesktopSessionEntry) -> Dict[str, Any]:
    session_manager = desktop_session_manager
    stream = getattr(entry.sandbox, "stream", None)
    if not stream:
        raise E2BModelRunnerError("Desktop streaming is not available in this SDK version.")
    with entry.lock:
        try:
            stream.stop()
        except Exception:
            pass
        entry.stream_active = False
        entry.stream_auth_key = None
        entry.stream_window_id = None
        entry.stream_started_at = None
    _stop_recording(entry)
    session_manager._append_event(entry, {
        "id": str(uuid.uuid4()),
        "kind": "desktop_stream",
        "label": "Stream stopped",
        "status": "completed",
        "startedAt": _now_iso(),
        "finishedAt": _now_iso(),
    })
    return {
        "stopped": True,
        "recording": {
            "status": "recording" if entry.recording_active else "stopped",
            "started_at": _iso_from_ts(entry.recording_started_at),
            "stopped_at": _iso_from_ts(entry.recording_stopped_at),
            "interval_ms": entry.recording_interval_ms,
            "frame_count": len(entry.recording_frames),
            "manifest_key": entry.recording_manifest_key,
        },
    }
