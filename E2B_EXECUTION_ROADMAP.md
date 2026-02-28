# E2B Execution Roadmap

This roadmap breaks work into phases with file-level touchpoints and validation steps.

## Phase 1 — Runtime parity (commands + PTY)
**Goal:** Background commands, streaming output, PTY support, and session close.

**Files**
- Runner service:
  - `e2b-runner-service/sessions.py`
  - `e2b-runner-service/main.py`
  - `e2b-runner-service/env_example.txt`
  - `e2b-runner-service/README.md`
- App routes:
  - `src/app/api/runner/sessions/[sessionId]/commands/**`
  - `src/app/api/runner/sessions/[sessionId]/pty/**`
  - `src/app/api/runner/sessions/[sessionId]/route.ts`
- Agent tools + registry:
  - `src/lib/agent/tools/e2b-runner.ts`
  - `src/lib/agent/coordinator.ts`
  - `src/lib/agent/skills/orchestrator.ts`
  - `src/lib/agent/skills/software-engineer.ts`

**Validation**
- Start sandbox → run foreground command → check stdout/stderr + exit code.
- Start background command → poll status → confirm streaming updates in events.
- Start PTY → send input → confirm output updates.
- Stop session → verify status returns 404 and UI stops polling.

## Phase 2 — Desktop production (design → implementation)
**Goal:** Desktop session creation, streaming, screenshots + action APIs, new Canvas panel.

**Files**
- Runner service:
  - `e2b-runner-service/desktop_sessions.py` (new)
  - `e2b-runner-service/main.py` (new endpoints)
  - `e2b-runner-service/requirements.txt` (add `e2b-desktop`)
- App routes:
  - `src/app/api/runner/desktop/**` (new)
- UI:
  - `src/app/components/artifacts/DesktopArtifact.tsx` (new)
  - `src/lib/agent/artifact-mapping.ts` (register new artifact type)

**Validation**
- Create desktop session → fetch screenshot → send click/write → fetch updated screenshot.
- Start desktop stream → verify iframe renders and updates.
- Close session → verify polling stops.

## Phase 3 — Guardrails + scaling
**Goal:** Production hardening for long-lived sessions.

**Files**
- Runner service:
  - `e2b-runner-service/sessions.py` (limits + cleanup)
  - `e2b-runner-service/main.py` (rate-limit hooks)
- App routes:
  - `src/app/api/runner/**` (tokenization + throttling)

**Validation**
- Ensure TTL cleanup works.
- Enforce event/output caps.
- Simulate concurrent sessions and verify max session limits.

## Phase 4 — UX polish
**Goal:** Better visibility + workflows.

**Files**
- UI:
  - `src/app/components/artifacts/PythonSandboxArtifact.tsx` (streaming UX)
  - `src/app/components/ui/TerminalViewer.tsx` (optional enhancements)

**Validation**
- Verify terminal updates smoothly during streaming commands.
