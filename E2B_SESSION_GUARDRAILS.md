# E2B Session Guardrails (Security + Ops)

This document defines guardrails for long-lived or desktop-style sessions.

## Ownership + access control
- Require authenticated user + chat ownership for all `/api/runner/**` routes.
- Never expose runner URLs, tokens, or sandbox IDs to clients directly.
- Store session IDs server-side (artifacts/state) and validate them against chat ownership.
- Reject paths that escape allowed roots (`/code`, `/pipelines`) for file operations.

## Tokenization + client access
- Use short-lived, server-issued tokens if a browser needs to talk to a session endpoint.
- Prefer server-proxied actions (screenshot, input, file I/O) over direct access.
- When direct access is required (eg. noVNC), use:
  - short TTL tokens
  - per-session nonce
  - optional IP/UA binding

## Quotas + billing
- Enforce session TTL (`RUNNER_SESSION_TTL_SECONDS`) + max sessions (`RUNNER_MAX_SESSIONS`).
- Enforce per-user/minute billing when configured (session meters).
- Cap per-request file size and stream output size.
- Rate-limit high-frequency endpoints (events, screenshots, PTY output).

## Resource controls
- Limit concurrent background commands and PTY sessions per sandbox.
- Truncate stored output buffers (`RUNNER_MAX_STREAM_BYTES`) and events (`RUNNER_MAX_EVENTS`).
- Kill stale commands/PTYs on session close/expiry.

## Desktop-specific guardrails
- Limit desktop resolution and DPI ranges.
- Cap screenshot rate (server-side throttle).
- Require explicit user intent before creating a desktop session.
- Disable internet access when not required (configurable per session).
- Require auth for desktop streams and keep URLs short-lived.

## Operational hygiene
- Log session lifecycle events (create/start/close).
- Clean up expired sessions on request boundaries and via periodic cleanup.
- Return 410/404 for expired sessions and let the UI stop polling gracefully.
