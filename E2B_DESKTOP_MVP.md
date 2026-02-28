# E2B Desktop Production Design

Goal: deliver a production-grade “desktop” workflow powered by E2B’s Desktop SDK, with
server-only control, live streaming, and a Canvas panel for screenshots and actions.

## Desktop runtime choice
- Use the E2B Desktop Python SDK (`e2b-desktop`) and the default `desktop` template.
- The Desktop SDK exposes UI automation primitives and a streaming API (noVNC-like),
  with all control server-side and stream access gated.
- Keep the template name configurable via env (ex: `RUNNER_DESKTOP_TEMPLATE`) so the
  service can point at a custom desktop template when needed.

## Runner service (API + storage)
Add a lightweight desktop session manager alongside `sessions.py`.

### New endpoints (runner service)
- `POST /desktop/sessions`
  - Body: `{ resolution?: [w,h], dpi?: number, timeout_seconds?: number, env?: Record<string,string> }`
  - Returns: `{ desktop_session_id, resolution, dpi }`
- `GET /desktop/sessions/{desktop_session_id}`
  - Returns: status + last activity timestamps
- `POST /desktop/sessions/{desktop_session_id}/actions`
  - Body: `{ actions: DesktopAction[] }` executed sequentially
  - Actions: `click`, `double_click`, `scroll`, `move_mouse`, `write`, `press`, `drag`, `open`, `launch`, `wait`
- `GET /desktop/sessions/{desktop_session_id}/screenshot`
  - Returns: PNG (binary) or `{ screenshot_base64 }` for Canvas
- `POST /desktop/sessions/{desktop_session_id}/stream/start`
  - Body: `{ window_id?: string, require_auth?: boolean }`
  - Returns: `{ url, auth_key? }`
- `GET /desktop/sessions/{desktop_session_id}/stream`
  - Returns: `{ url, auth_key? }`
- `POST /desktop/sessions/{desktop_session_id}/stream/stop`
  - Stops the live stream
- `POST /desktop/sessions/{desktop_session_id}/close`
  - Closes the session and releases resources

### Session manager (runner)
- Maintain in-memory `DesktopSessionEntry` with:
  - `id`, `sandbox`, `created_at`, `last_access`, `status`, `events`
  - `resolution`, `dpi`, and optional metadata
  - `stream` state (active, window_id, auth)
- Mirror the existing event model so the UI can poll `/events`.
- Use env guardrails for TTL and max sessions (parallel to existing sandbox sessions).

### Dependencies
- Add `e2b-desktop` to `e2b-runner-service/requirements.txt`.
- Import guarded (same pattern as `e2b_code_interpreter`) to allow clean error messages
  when desktop dependencies are missing.

## Agent tools (server-only)
Expose a minimal toolset to the agent:
- `desktop_start` → calls `POST /desktop/sessions`
- `desktop_action` → calls `POST /desktop/sessions/{id}/actions`
- `desktop_screenshot` → calls `GET /desktop/sessions/{id}/screenshot`
- `desktop_stop` → calls `POST /desktop/sessions/{id}/close`
- `desktop_stream_start` → calls `POST /desktop/sessions/{id}/stream/start`
- `desktop_stream_stop` → calls `POST /desktop/sessions/{id}/stream/stop`

These tools return Canvas artifacts so users can see screenshots and action results.

## UI / Canvas (client)
Add a new Desktop artifact + panel:
- `DesktopArtifact` shows:
  - Latest screenshot
  - Live stream (iframe)
  - Refresh button
  - Optional action controls (send text, key presses)
- Polls `/api/runner/desktop/{sessionId}/screenshot` for updates
- Tracks actions/logs in the artifact payload:
  - `{ kind: "desktop_state_v1", sessionId, status, screenshotUrl, lastAction }`

## App-facing API routes (Next.js)
Add runner proxies under `src/app/api/runner/desktop`:
- `POST /api/runner/desktop/sessions`
- `GET /api/runner/desktop/sessions/{id}`
- `POST /api/runner/desktop/sessions/{id}/actions`
- `GET /api/runner/desktop/sessions/{id}/screenshot`
- `POST /api/runner/desktop/sessions/{id}/close`

All routes enforce chat ownership and keep runner tokens server-only.

## Production validation
- Start desktop session, fetch screenshot, perform a click or write, fetch updated screenshot.
- Start live stream, verify iframe renders and stays active.
- Ensure session close cleans resources and ends polling cleanly.
