# E2B Capabilities Map (Current)

This document captures what is implemented today across agent tools, the runner service,
app-facing API routes, and UI panels.

## Current vs Planned (mission alignment)
**Current:** sandbox execution for preprocessing/EDA, long-running training tasks (submit → poll → download), and desktop sessions for GUI workflows.

**Planned / gaps:** multi-provider or multi-cluster orchestration, automated deployment/hosting pipelines, and deeper model analysis dashboards (beyond logs/metrics artifacts).

## Agent tools (server-only)
- Training: `training_submit`, `training_status`, `training_download`.
- Sandbox sessions: `sandbox_start`, `sandbox_stop`, `sandbox_exec`, `sandbox_upload`, `sandbox_download`, `sandbox_browser`.
- Background/streaming commands: `sandbox_command_start`, `sandbox_command_status`, `sandbox_command_send`, `sandbox_command_kill`.
- Interactive terminals: `sandbox_pty_start`, `sandbox_pty_status`, `sandbox_pty_send`, `sandbox_pty_resize`, `sandbox_pty_kill`.
- Sandbox persistence and external publishing:
  - `sandbox_persist_tree` for recursive folder/file persistence to Outputs storage.
  - `github_repo_checkout`, `github_repo_publish` for connected-repo edit flows (default branch `tuna` + PR unless instructed otherwise).
- Kaggle workflows: `kaggle_dataset_download`, `kaggle_dataset_upload`, `kaggle_competition_submit`, `kaggle_kernel_push`.
- Desktop sessions: `desktop_start`, `desktop_action`, `desktop_screenshot`, `desktop_stop`.
- Desktop streaming: `desktop_stream_start`, `desktop_stream_stop`.
- All runner calls are server-side; no runner URLs or tokens are exposed to clients.

## Runner service (`e2b-runner-service`)
- Tasks (training):
  - Submit: `POST /tasks` (multipart) and `POST /tasks/by-reference` (JSON).
  - Inspect: `GET /tasks/{task_id}/status`.
  - Outputs: `GET /tasks/{task_id}/output`, `/output/log`, `/output/metadata`, and `/download?file=...`.
- Sessions:
  - Create: `POST /sessions`.
  - One-off exec: `POST /sessions/{session_id}/exec`.
  - Commands API: `POST /sessions/{session_id}/commands` with background + streaming support,
    plus `/commands/{pid}` status, `/stdin`, and `/kill`.
  - PTY API: `POST /sessions/{session_id}/pty`, plus `/pty/{pid}` status, `/stdin`, `/resize`, `/kill`.
  - Files: upload/list/download via `/files` + `/files/content`.
  - Browser: `POST /sessions/{session_id}/browser` (Playwright).
  - Kaggle:
    - `POST /sessions/{session_id}/kaggle/datasets/download`
    - `POST /sessions/{session_id}/kaggle/datasets/upload`
    - `POST /sessions/{session_id}/kaggle/competitions/submit`
    - `POST /sessions/{session_id}/kaggle/kernels/push`
  - Status/events: `GET /sessions/{session_id}/status` and `/events`.
  - Close: `DELETE /sessions/{session_id}`.
- Desktop:
  - Create: `POST /desktop/sessions`.
  - Status: `GET /desktop/sessions/{desktop_session_id}`.
  - Actions: `POST /desktop/sessions/{desktop_session_id}/actions`.
  - Screenshot: `GET /desktop/sessions/{desktop_session_id}/screenshot`.
  - Close: `POST /desktop/sessions/{desktop_session_id}/close`.
  - Stream: `POST /desktop/sessions/{desktop_session_id}/stream/start`, `GET /desktop/sessions/{desktop_session_id}/stream`, `POST /desktop/sessions/{desktop_session_id}/stream/stop`.
- Guardrails (env-configured):
  - Session TTL and max sessions.
  - Max input size, file size, and event count.
  - Stream buffer size + stream event cadence.

## App-facing API routes (Next.js)
- Runner proxies under `src/app/api/runner`:
  - Session status/events/files and new commands/PTY routes (chat ownership enforced).
  - Download proxy for training outputs (`/api/runner/download`).
- Chat/agent orchestration under `src/app/api/chat/*`:
  - Streaming via SSE.
  - Tool calls and artifact updates (server-side).

## UI panels and artifacts
- Composer `+` menu:
  - `Upload files`
  - `Connect to GitHub`
  - `Connect to HuggingFace`
- `PythonSandboxArtifact`:
  - Polls `/api/runner/sessions/{sessionId}/events` and `/status`.
  - Shows terminal output (xterm), files panel, and browser snapshots.
- `TrainingArtifact`:
  - Displays training status, stdout/stderr snippets, and download links.
- `DesktopArtifact`:
  - Shows desktop screenshots and latest action.
- `FilesDrawer`:
  - Manages uploads, artifact files, and sandbox files.
- `TerminalViewer`:
  - Read-only terminal rendering (xterm.js).

## Data flow (high level)
- Agent tools call runner service (server-only) and persist sandbox/training state to artifacts.
- UI reads artifacts and polls runner proxy endpoints for live updates.
- Storage and integration tokens remain server-only and never appear in client bundles.

## Validation snapshot (2026-02-09)
- `npx eslint` (targeted changed files): passes with warnings only in pre-existing areas (`appendDesktopEvent`, `markdown` in `e2b-runner.ts`).
- `python -m py_compile sessions.py main.py runner.py` in `e2b-runner-service`: passes.
- `npx tsc --noEmit`: fails due to pre-existing `SourceTier` typing issues in `dataset-search.ts` and `model-search.ts` (outside this delivery scope).
