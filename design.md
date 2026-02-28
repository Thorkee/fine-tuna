## UI/UX Design — Tuna Console

This document describes the **implemented** UI/UX design of the Tuna Console (agentic chat + Canvas), focusing on interaction patterns, visual system, responsive behavior, and state transitions.

- **Audience**: product/design + engineers working on the frontend
- **Scope**: UI/UX only (layout, components, flows, affordances, accessibility, motion)
- **Source-of-truth**: the codebase (paths linked inline throughout)
- **Non-goals**: backend architecture and secrets. This doc intentionally avoids sensitive server details and tokens.

### Table of contents

- **Product intent**
  - [Experience goals](#experience-goals)
  - [Primary screens / routes](#primary-screens--routes)
- **Design system**
  - [Technology + implementation approach](#technology--implementation-approach)
  - [Theme model (light/dark/system) and “no flash” boot](#theme-model-lightdarksystem-and-no-flash-boot)
  - [Color tokens and surfaces](#color-tokens-and-surfaces)
  - [Typography](#typography)
  - [Elevation, glass, and “Mac window” metaphors](#elevation-glass-and-mac-window-metaphors)
  - [Motion system](#motion-system)
- **Shell layout**
  - [Global app layout](#global-app-layout)
  - [Sidebar: navigation, search, account](#sidebar-navigation-search-account)
  - [Chat + Canvas split view](#chat--canvas-split-view)
  - [Mobile layout rules](#mobile-layout-rules)
- **Core interaction patterns**
  - [Composer (input, send, attachments, queued sends)](#composer-input-send-attachments-queued-sends)
  - [Message rendering: content vs reasoning vs trace](#message-rendering-content-vs-reasoning-vs-trace)
  - [Artifacts: cards in chat, panels in Canvas](#artifacts-cards-in-chat-panels-in-canvas)
  - [Canvas timeline (scrub, replay, live)](#canvas-timeline-scrub-replay-live)
  - [Files drawer (uploads, outputs, sandbox)](#files-drawer-uploads-outputs-sandbox)
  - [Settings / Credits modal](#settings--credits-modal)
  - [Share modal + shared replay view](#share-modal--shared-replay-view)
- **Onboarding and authentication**
  - [Login (email OTP + Google)](#login-email-otp--google)
  - [Onboarding wizard](#onboarding-wizard)
- **Accessibility, resilience, and quality**
  - [Accessibility conventions](#accessibility-conventions)
  - [Loading/empty/error states](#loadingemptyerror-states)
  - [State management + scoping](#state-management--scoping)
  - [Guidelines for adding new UI](#guidelines-for-adding-new-ui)
- **Replication appendix (pixel-identical spec)**
  - [Replication checklist (pixel-identical)](#replication-checklist-pixel-identical)
  - [Exact design tokens (CSS variables)](#exact-design-tokens-css-variables)
  - [Breakpoints and responsive rules (exact)](#breakpoints-and-responsive-rules-exact)
  - [Z-index and layering map (exact)](#z-index-and-layering-map-exact)
  - [Component blueprints (exact class recipes)](#component-blueprints-exact-class-recipes)
  - [Motion constants (Framer and CSS)](#motion-constants-framer-and-css)
  - [Keyboard shortcuts (exact)](#keyboard-shortcuts-exact)

---

## Experience goals

Tuna Console's UI is designed around a single mental model:

- **Chat = intent + decisions**
- **Canvas = durable working memory and deliverables**

That yields a UX that stays “in flow” while still supporting complex multi-step work (training workflows, sandboxes, desktop sessions, documents/spreadsheets).

Key goals:

- **Fast perceived responsiveness**: pre-paint theme + sidebar width init; optimistic UI; streaming; minimal layout shift.
- **Progressive disclosure**: answer vs trace vs reasoning are distinct, collapsible blocks; artifacts appear as compact cards and open in a dedicated workspace.
- **Low cognitive load**: stable layout; “one primary action” per surface; consistent component styling; calm backgrounds and subtle motion.
- **Cross-device usability**: full desktop split view; mobile focuses on one pane at a time with safe-area padding.
- **Safety-by-design (UX)**: sharing includes explicit warnings; file editing is constrained; read-only modes are enforced in replay contexts.

## Primary screens / routes

Routes implemented under `src/app/`:

- **Chat (main workspace)**: `src/app/[[...chatId]]/page.tsx`
  - New chat and existing chats share the same shell (“ChatShell”).
- **Login**: `src/app/login/page.tsx`
- **Onboarding**: `src/app/onboarding/page.tsx`
- **Usage dashboard (credits ledger)**: `src/app/settings/usage/page.tsx`
- **Shared chat replay**: `src/app/share/[shareId]/page.tsx` + `src/app/share/[shareId]/SharedChatReplay.tsx`

---

## Technology + implementation approach

The UI is implemented as:

- **Next.js App Router** (`next@16`) + **React 19**
- **Tailwind CSS v4** via CSS-first import (`@import "tailwindcss";`) in `src/app/globals.css`
- **Typography**: `@tailwindcss/typography` plugin for `.prose` rendering (Markdown content blocks)
- **Motion**:
  - **Framer Motion** for structural transitions (sidebars, modals, split view, message entrance)
  - **CSS keyframes** for micro motion (shimmer, fade, bounce, pulse) defined in `src/app/globals.css`
- **Component primitives**:
  - **Radix Tooltip** (`src/components/ui/tooltip.tsx`) for low-friction hover affordances
- **State**:
  - **Zustand** store for artifact data scoped by chat/share (`src/lib/store.ts`, `src/lib/hooks/useProjectArtifacts.ts`, `src/lib/artifact-scope.tsx`)
- **Rich artifacts**:
  - TipTap document editor (`src/app/components/artifacts/DocumentArtifact.tsx`)
  - Fortune Sheet spreadsheet (`src/app/components/artifacts/SpreadsheetArtifact.tsx`)
  - xterm terminal viewer (`src/app/components/ui/TerminalViewer.tsx`)

The guiding implementation rule is: **use Tailwind utilities for layout and spacing, but rely on CSS custom properties for theme semantics** (background/text/border/accent), so the app can evolve its visual identity without rewriting every component.

---

## Theme model (light/dark/system) and “no flash” boot

### Theme preference

Theme selection supports:

- **Light**
- **Dark**
- **System** (tracks OS preference changes live)

Implementation sources:

- **Pre-hydration init (pre-paint)**: `src/app/layout.tsx`
  - Injects a small `<script>` into `<head>` to set `document.documentElement[data-theme]` before React hydration, preventing a “flash of wrong theme”.
- **Runtime hydration + persistence**: `src/app/[[...chatId]]/page.tsx`
  - Reads/writes a preference key **`tuna.theme`** to both `localStorage` and a cookie (1-year max-age).
  - Resolves `"system"` via `matchMedia("(prefers-color-scheme: dark)")` and subscribes to OS changes.
- **Settings UI**: `src/app/components/ui/CreditsModal.tsx`
  - Appearance section exposes Light/Dark/System with `aria-pressed` buttons.

### Dark mode utilities with Tailwind v4

Tailwind’s `dark:` utilities are adapted to use `data-theme=dark` instead of the default class-based approach:

- `src/app/globals.css` defines:
  - `@custom-variant dark (&&:where([data-theme=dark], [data-theme=dark] *));`

This is why most components can simply use Tailwind’s `dark:` variants while the theme switcher stays attribute-driven and SSR-friendly.

### Sidebar width “no jump” boot

In the same pre-paint pattern, the app ensures the sidebar doesn’t “pop” on first render:

- `src/app/layout.tsx` reads `tuna.sidebar.collapsed` and sets:
  - `document.documentElement[data-sidebar-collapsed]`
  - `--sidebar-width` CSS var (`72px` collapsed, `280px` expanded)
- `src/components/Sidebar.tsx` keeps those values synced whenever the user toggles collapse.
- The sidebar is dynamically imported in `src/app/[[...chatId]]/page.tsx` with a loading placeholder using `--sidebar-width`.

---

## Color tokens and surfaces

### Token philosophy

The visual system is driven by **semantic CSS variables** (not raw hex values sprinkled in components). The tokens live in:

- `src/app/globals.css`

Core semantic groups:

- **Backgrounds**: `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-elevated`
- **Text**: `--text-primary`, `--text-secondary`, `--text-muted`, `--text-subtle`
- **Borders**: `--border-default`, `--border-hover`, `--border-focus`
- **Accents**: `--accent-violet`, `--accent-purple`, `--accent-blue`, `--accent-green`, `--accent-amber`, `--accent-red`
- **Radii**: `--radius-sm/md/lg/xl`
- **Timing**: `--transition-fast/normal/slow`, `--spring`, `--ease-out-expo`

For Tailwind interoperability, several aliases are also defined:

- `--background`, `--foreground`, `--card`, `--muted`, `--border`, etc.

### Light vs dark

Dark mode is not a simple inversion; it uses its own tuned values to preserve contrast and reduce glare:

- `:root` defines light defaults
- `[data-theme="dark"]` overrides variables and sets `color-scheme: dark`

### Branding details

The Tuna logo uses a theme-dependent filter:

- `.brand-logo { filter: var(--logo-filter); }`
- dark mode sets `--logo-filter` to an invert + hue rotation that keeps the brand accent readable.

---

## Typography

### Primary font

- The app loads **Nunito Sans** via `next/font/google` in `src/app/layout.tsx`
  - exported as CSS variable `--font-nunito-sans`

### Content typography (Markdown)

Chat content and many artifact renderers use `.prose` from Tailwind Typography:

- `src/app/[[...chatId]]/page.tsx`: message `content`, `reasoning`, `trace` blocks render with `ReactMarkdown + remark-gfm` and `.prose` utilities.
- `src/app/components/ui/GenericArtifactRenderer.tsx`: rich Markdown rendering for generic artifacts.

### Monospace

Code and terminal UIs use system monospace stacks:

- Terminal logs: `src/app/components/ui/TerminalViewer.tsx`
- Inline code styling: defined in Markdown renderers (adds subtle background + rounding).

---

## Elevation, glass, and “Mac window” metaphors

The console leans on a “premium glass” metaphor: bright surfaces with blur and subtle borders/shadows.

Source-of-truth classes (defined in `src/app/globals.css`):

- **Glass panels**:
  - `.glass`, `.glass-subtle`, `.glass-strong`
  - `.glass-panel`, `.glass-panel-strong` (shared panels)
  - `.glass-header` (sticky-ish headers)
- **Mac-style frame**:
  - `.macos-frame` (outer frame)
  - `.macos-titlebar` (top bar)
- **Cards**:
  - `.glass-card`, `.glass-inset`
  - `.interactive-card` for hoverable choice cards

Canvas uses this explicitly (see `src/app/[[...chatId]]/page.tsx`):

- Rounded container with `glass-panel macos-frame`
- Titlebar with red/amber/green “window dots”

This metaphor is intentional: the Canvas is treated as a **separate workspace** from the chat transcript.

---

## Motion system

Motion is used for:

- **Orientation** (panels opening, modals appearing)
- **Continuity** (layout changes that would otherwise feel like jumps)
- **Status feedback** (loading shimmer, progress rings, “typing” dots)

### Framer Motion (structural)

Common patterns:

- `AnimatePresence` for mount/unmount transitions (modals, mobile sidebar, canvas)
- Spring transitions for width/position shifts (sidebar collapse, split-view pane)

Key files:

- `src/app/[[...chatId]]/page.tsx`
- `src/components/Sidebar.tsx`
- `src/app/login/page.tsx`
- `src/app/onboarding/page.tsx`
- `src/app/share/[shareId]/SharedChatReplay.tsx` (also considers reduced motion)

### CSS keyframes (micro)

Defined in `src/app/globals.css`:

- `fadeIn`, `fadeInUp`, `fadeInDown`, `fadeInScale`
- `shimmer` (loading skeleton)
- `typingDot` (thinking/typing indicator)
- `pulse`, `pulseGlow`
- plus utility classes: `.animate-fade-in-up`, `.animate-shimmer`, etc.

Guideline used throughout:

- **Fast UI feedback**: ~140–200ms for micro transitions
- **Softer layout shifts**: ~300–600ms for big workspace changes (split view, large panels)

---

## Global app layout

### Root layout responsibilities

`src/app/layout.tsx` establishes:

- **Viewport**: `viewportFit: "cover"` to handle notches/safe area properly
- **Theme + sidebar init scripts** in `<head>` (pre-paint)
- **Font**: Nunito Sans variable applied on `<body>`
- **Min height**: `min-h-dvh` for consistent mobile viewport handling

### Global CSS responsibilities

`src/app/globals.css` provides:

- Tailwind import + typography plugin
- Theme tokens + background/text defaults
- Safe-area utilities: `.safe-area-px`, `.safe-area-py`, `.safe-area-pt`, `.safe-area-pb`
- Scrollbar styling and a `.scrollbar-hide` utility
- Reusable component classes (buttons, cards, glass)

---

## Sidebar: navigation, search, account

Primary implementation:

- `src/components/Sidebar.tsx`

### Layout and collapse behavior

- **Expanded** width: 280px
- **Collapsed** width: 72px
- Collapse state is persisted via:
  - `localStorage["tuna.sidebar.collapsed"]`
  - cookie `tuna.sidebar.collapsed`
  - and mirrored onto:
    - `document.documentElement[data-sidebar-collapsed]`
    - `--sidebar-width`

Design intent:

- **Collapsed mode** is a “wide icon rail” that stays usable (tooltips on key actions).
- **Expanded mode** shows full navigation and chat history with section headers.

### Chat list UX

Chat threads are grouped by recency:

- Today / Yesterday / Previous 7 days / Previous 30 days / Older

This creates immediate wayfinding without requiring a separate “search-first” workflow.

### Search UX (Cmd/Ctrl+K)

The sidebar includes a ChatGPT-style search modal:

- **Shortcut**: Cmd/Ctrl + K
- **Keyboard navigation**: up/down selects items, Enter opens
- **Escape** closes
- **Body scroll lock** while open

### Account footer

The footer provides:

- Credits badge (click opens Usage/Settings)
- Profile menu (Settings / Usage / Theme / Sign out)
- “Finish setup” hint if onboarding incomplete

---

## Chat + Canvas split view

Primary implementation:

- `src/app/[[...chatId]]/page.tsx` (`ChatShell`)

### Layout regions (desktop)

The main workspace is:

- **Left**: chat transcript + composer
- **Right**: Canvas (artifact panels) in a Mac-window frame
- **Between**: a draggable resize handle

Resizing behavior:

- Canvas width is stored as a percentage in component state
- Clamped to **30%–70%** to keep both panes usable
- Resizing is disabled while **desktop takeover** is active (to avoid input conflicts)

### Canvas header affordances

The Canvas titlebar provides:

- Close button (when allowed) styled like macOS “red dot”
- Files button (opens `FilesDrawer`)
- Centered title ("Tuna's Computer") to reinforce the workspace metaphor

### Canvas content

Canvas hosts one or more “panels”:

- Some are 1:1 with artifact IDs (plan, research, analysis, training, export, document, spreadsheet, etc.)
- Sandbox is split into subpanels (`sandbox-code`, `sandbox-terminal`, `sandbox-files`, `sandbox-browser`)

Panel mapping rules live in:

- `src/lib/agent/canvas-panels.ts`

---

## Mobile layout rules

Breakpoints follow Tailwind defaults and explicit media queries:

- `useMediaQuery("(min-width: 768px)")` is used for drawer/list behaviors
- `useMediaQuery("(min-width: 1024px)")` (in ChatShell) gates split-view vs single-pane

Mobile principles:

- **One primary surface at a time**:
  - Chat or Canvas
  - Canvas opens as a fullscreen modal when active
- **Safe-area padding** is applied for top bars and bottom composer spacing using `env(safe-area-inset-*)`.

Mobile-specific elements in `src/app/[[...chatId]]/page.tsx`:

- Mobile top bar includes a hamburger menu that opens a sidebar drawer.
- Canvas opens as a fullscreen modal (`mobilePane === "canvas"`), with:
  - Back-to-chat button
  - Files button
  - Timeline bar anchored to the bottom with safe-area padding

---

## Composer (input, send, attachments, queued sends)

Primary implementation:

- `src/app/[[...chatId]]/page.tsx` (composer block)
- `src/app/components/ui/ComposerAttachMenu.tsx`

### Text input behavior

- Text input is a `textarea` that supports multi-line.
- **Enter** sends when not holding Shift.
- **Shift+Enter** inserts a newline.
- IME composition is respected (`nativeEvent.isComposing`) to avoid accidental sends mid-composition.

### Send button states

The send control is visually explicit:

- Enabled: high-contrast filled circle with subtle scale interaction (`hover:scale-105`, `active:scale-95`)
- Disabled: muted background and reduced contrast

### Attachments

Attachment entry points:

- “+” button opens `ComposerAttachMenu` with:
  - Upload files
  - Connect GitHub
  - Connect Hugging Face

File input constraints (current UI accept list):

- `.csv`, `.json`, `.jsonl`, `.parquet`, `.xlsx`

Attached files render as small rounded “chips” with:

- Filename truncation
- Uploading state text (“Uploading…”)
- Remove (X) button when upload is complete

### Queued sends

When an agent run is already active, additional user sends are **queued** instead of rejected:

- The UI surfaces a queued count and a preview of the next queued message
- Users can **Edit** or **Clear** the queue
- If the composer is empty, pressing **Enter** again can send the next queued message immediately (context-aware keyboard behavior)

This pattern avoids blocking the user while preserving deterministic ordering.

---

## Message rendering: content vs reasoning vs trace

Primary implementation:

- `src/app/[[...chatId]]/page.tsx`
- Supporting UI blocks:
  - `src/app/components/ui/AgentStatusCard.tsx`
  - `src/app/components/ui/TakeoverCard.tsx`
  - `src/app/components/ui/ClarificationCard.tsx`
  - `src/app/components/ui/ChatCodeArtifact.tsx`

### Render order model

Assistant messages can contain multiple “sub-blocks”:

- **Reasoning** (collapsible)
- **Status** (agent step indicator)
- **Trace** (collapsible)
- **Answer** (main content)
- **Files** (download chips)

Ordering is either:

- explicitly provided by message metadata (`render_order`), or
- derived via a deterministic fallback.

Design intent:

- **Keep the answer readable** (content is always present if there is any displayable content)
- **Keep details accessible** (trace/reasoning are one click away)
- **Prevent clutter** (collapsed previews are single-line and truncated)

### Collapsible Reasoning and Trace

Reasoning and Trace segments share a common pattern:

- A small uppercase label (“Reasoning” / “Trace”)
- A compact one-line preview when collapsed
- A pulse dot while streaming
- Expanded view renders Markdown with consistent `.prose` styling

Important UX note: the UI is structured so that “details” are opt-in; users see the answer first unless they open deeper blocks.

### Markdown behavior (links, images, code)

Markdown is rendered using:

- `ReactMarkdown` + `remark-gfm`

Special handling:

- **Storage-like links and image links** render as a compact “Open” chip/button (instead of inline images) to:
  - keep the transcript readable
  - avoid huge inline media
  - route link opening through a safe “open in new tab” flow
- **Code blocks**:
  - If the language is detected (`language-xxx`), the UI can elevate certain blocks into higher-level affordances.
  - Python blocks are converted into `ChatCodeArtifact` which offers “Open in Sandbox”.

### Agent status block

`AgentStatusCard` shows:

- Current phase label (humanized)
- Pulsing dot if active
- Optional expansion to show step history with timestamps

This makes “the agent is doing something” legible without flooding the transcript.

### Takeover-required block

When the agent needs user intervention (desktop takeover), the message can show `TakeoverCard`:

- Warns clearly that a takeover is required
- Provides actionable steps
- Avoids false positives (only shown when an explicit takeover payload is present)

### Clarification block

Clarification UX is adaptive:

- **Mobile**: clarification form can render inline to keep the user in a single pane.
- **Desktop**: clarification becomes an artifact card that opens in Canvas (keeps transcript clean).

---

## Artifacts: cards in chat, panels in Canvas

Artifacts are the bridge between chat and Canvas.

### Artifact cards in the transcript

Some assistant messages are “artifact messages” (lightweight references). The UI renders them as `ChatArtifactCard`:

- Small glass card
- Icon + title
- Optional preview hint (e.g., a web search query)
- “Deliverable” badge for key outputs (`isDeliverableArtifactId`)

File:

- `src/app/components/ui/ChatArtifactCard.tsx`

### Artifact panels in Canvas

Canvas panels render the actual artifact UI. Notable built-ins:

- **Plan**: `src/app/components/artifacts/PlanArtifact.tsx`
  - Step list with status icons (todo/doing/blocked/done/failed/skipped)
  - Header shows progress (done/total + progress bar)
- **Web research**: `src/app/components/artifacts/ResearchArtifact.tsx`
  - Sources list with safe highlight rendering
  - Copy citation affordance
- **Analysis / Providers / Export**: specialized panels that either show real data or a high-quality placeholder until data arrives:
  - `DataAnalysisArtifact.tsx`, `ProviderComparisonArtifact.tsx`, `ExportArtifact.tsx`
- **Training**: `src/app/components/artifacts/TrainingArtifact.tsx`
  - Status badges + log streams rendered through `TerminalViewer`
- **Document**: `src/app/components/artifacts/DocumentArtifact.tsx`
  - Rich text editor (TipTap), debounced autosave, import `.docx`, export to `.docx`
  - Sanitizes HTML (DOMPurify) before rendering/persisting
- **Spreadsheet**: `src/app/components/artifacts/SpreadsheetArtifact.tsx`
  - Spreadsheet editor (Fortune Sheet), debounced autosave, import `.xlsx`, export `.xlsx`
- **Sandbox**: `src/app/components/artifacts/PythonSandboxArtifact.tsx`
  - Multiple subpanels (code/terminal/files/browser)
  - Clear empty states and status pills
- **Desktop**: `src/app/components/artifacts/DesktopArtifact.tsx`
  - Live stream/replay, explicit “take control” vs “hand back” workflow
  - Enforces read-only behavior when rendered in shared replay contexts
- **Clarification**: `src/app/components/artifacts/ClarificationArtifact.tsx`
  - Renders `ClarificationCard` and stores a response state into the artifact data
- **Intent**: `src/app/components/artifacts/IntentArtifact.tsx`
  - Summarizes inferred task type, I/O, clarifications, blockers (often hidden from transcript)

### Generic artifact renderer

When an artifact doesn’t have a bespoke UI (or is a structured payload), `GenericArtifactRenderer` provides a robust fallback:

- `src/app/components/ui/GenericArtifactRenderer.tsx`

Capabilities include:

- Render Markdown if present
- Expand “table-like” structures into Markdown tables
- Render JSON prettily when needed
- Provide “Open” chips for storage/image links

---

## Canvas timeline (scrub, replay, live)

Primary implementation:

- UI: `src/app/components/ui/CanvasTimelineBar.tsx`
- Timeline logic: `src/lib/agent/canvas-timeline.ts`

Design intent:

- The Canvas is not only “current state” — it’s a **replayable history** of how artifacts changed over time.

Timeline controls:

- **Scrub** via range slider
  - `onScrubPreview` updates the preview immediately while dragging
  - `onScrubCommit` finalizes the chosen frame on release/keyboard commit
- **Step back/forward** buttons
- **Play/Pause** (replay)
- **Live indicator** (dot + label)
- **Jump to live** appears when viewing historical frames

Accessibility:

- Buttons have `aria-label`s (“Step back”, “Play/Pause”, “Jump to live”)
- Keyboard interactions on the slider commit on arrows/home/end

---

## Files drawer (uploads, outputs, sandbox)

Primary implementation:

- `src/app/components/ui/FilesDrawer.tsx`

Purpose:

- Give users a unified place to manage files tied to a chat:
  - uploaded inputs
  - produced outputs
  - sandbox workspace files

### Sources + navigation

The drawer exposes three sources:

- **Uploads**: user-attached files
- **Outputs**: generated artifacts/exports/tool outputs
- **Sandbox**: live session filesystem (rooted at `/code` and `/pipelines`)

Each source supports:

- Search filtering
- Folder grouping (uploads/outputs)
- Breadcrumb-like “up” navigation

### Preview model

The right side is a file preview with modes:

- **View**: show preview (text, CSV, images) or a fallback “too large”
- **Edit**: for “text-like” files only (extensions allowlist)

CSV previews are intentionally capped:

- Up to **120 rows** and **12 columns** (with truncation indicators)

### Editing guardrails

To prevent accidental destructive edits:

- Only “text-like” files can be edited.
- Sandbox edits are limited to paths under **`/code`** (explicitly guarded).

### Primary actions

Depending on selection and source, the drawer offers:

- **Copy ref** (copies storage path or sandbox path)
- **Attach** (attaches a selected file into the composer as a chat attachment)
- **Download**
- **Rename/Move** (uploads/outputs)
- **Delete** (uploads/outputs; confirmation required)
- **Copy to sandbox** (storage → sandbox)
- **Persist to outputs** (sandbox → outputs)
- **Persist current folder** (sandbox folder → outputs)

Responsive behavior:

- On mobile, the drawer toggles between **list** and **preview** views to keep controls tappable.

---

## Settings / Credits modal

Primary implementation:

- `src/app/components/ui/CreditsModal.tsx`

This modal is the “control center” for:

- Account and usage views
- Appearance (theme)
- Communication preferences
- Personalization
- Skills toggles
- Integrations

Appearance section:

- Theme preference buttons: Light / Dark / System
- Uses `aria-pressed` for selection semantics

Design intent:

- Keep “core workspace” uncluttered; secondary controls live in a modal that can be summoned quickly from the sidebar.

---

## Share modal + shared replay view

### Share modal

Primary implementation:

- `src/app/components/ui/ShareChatModal.tsx`

UX characteristics:

- Clear privacy warning: “Review before sharing”
- Auto-creates the share link when opened (so social share buttons can open synchronously)
- Copy-to-clipboard with short-lived “copied” feedback
- Preview shows the last few meaningful messages (excluding artifact-reference messages)

### Shared replay

Primary implementation:

- `src/app/share/[shareId]/SharedChatReplay.tsx`

Shared replays are **read-only** by design:

- No editing, no live control operations
- Desktop/Sandbox panels enforce read-only mode
- Timeline playback is available so shared viewers can understand the evolution of artifacts

---

## Login (email OTP + Google)

Primary implementation:

- `src/app/login/page.tsx`

UX characteristics:

- Two-step flow:
  - email entry → OTP entry
- OTP entry:
  - 8-digit visual boxes with a single hidden input capturing numeric input
  - Auto-submit when 8 digits entered
  - Resend timer with disabled state until countdown completes
- Ambient blurred background blobs for a premium but quiet feel
- Safe-area padding (`safe-area-py`) for notch devices

---

## Onboarding wizard

Primary implementation:

- `src/app/onboarding/page.tsx`

UX characteristics:

- Multi-step wizard with animated transitions (direction-aware slide + blur)
- Validations at critical steps (e.g. full name length)
- Supports **edit mode** (re-enter onboarding to change preferences) without blocking the app
- Stores preferences used to tailor the agent experience (goal, mode, instructions, comm prefs)

Design intent:

- Collect enough context to improve agent quality without overwhelming the user:
  - basic identity
  - background
  - goal
  - default mode
  - “custom instructions”

---

## Accessibility conventions

The UI uses a pragmatic accessibility baseline:

- **Keyboard support**:
  - Escape closes modals/drawers
  - Cmd/Ctrl+K opens chat search
  - Range slider supports arrow/home/end for timeline scrubbing
- **ARIA**:
  - Dialogs use `role="dialog"` + `aria-modal="true"` and descriptive labels
  - Toggle-like buttons use `aria-pressed` where appropriate
  - Collapsible blocks use `aria-expanded`
- **Focus styling**:
  - Default outlines are removed globally (`*:focus-visible { outline: none; }`)
  - Interactive controls add explicit focus rings via Tailwind utilities (e.g. `focus-visible:ring-*`)

Safe-area considerations:

- `viewportFit: cover` + safe-area utility classes ensure tappable content is not hidden behind notches/home indicators.

---

## Loading/empty/error states

The UI emphasizes “always show something useful”:

- **Chat loading overlay** when switching chats (prevents interacting with stale state)
- **Canvas “Updating…” banner** when artifact updates are streaming in
- **ArtifactLoadingState**:
  - Panel variant (centered) and inline variant (compact)
  - `src/app/components/ui/ArtifactLoadingState.tsx`
- **Sandbox/Desktop empty states**:
  - Clear explanation + “waiting for updates” hint
  - Encourages the right next action (“ask agent to start a session”)
- **Files drawer**:
  - “File too large to preview. Use Download.”
  - Edit restrictions are explained in human language (e.g. sandbox edit limited to `/code`)

---

## State management + scoping

### Why scoping exists

Artifacts (and some UI state) are **chat-specific**. Without scoping, it’s easy to accidentally “leak” the previous chat’s Canvas into a new chat.

Implementation:

- **Artifact scope provider**: `src/lib/artifact-scope.tsx`
  - provides `scopeId` + `chatId` to descendants
- **Zustand store**: `src/lib/store.ts`
  - keeps `artifactStateByScope` so each chat/share has isolated `activeArtifact`, `artifacts`, `sandboxCode`
- **Hook**: `src/lib/hooks/useProjectArtifacts.ts`

Persistence strategy (UX-driven):

- From store version 2 onward, chat/canvas-specific state is **not persisted** in local storage to prevent cross-chat leakage. Only project-level fields are persisted.

---

## Guidelines for adding new UI

When adding or evolving UI in this repo, align with the existing system:

- **Use semantic tokens** from `src/app/globals.css`:
  - Prefer `bg-secondary`, `border-default`, `text-muted`, etc. over raw colors.
- **Respect theme and safe area**:
  - Avoid hard-coded light-only backgrounds.
  - Ensure mobile top/bottom bars account for `env(safe-area-inset-*)`.
- **Prefer progressive disclosure**:
  - If adding “details” (debug, logs, metadata), default to collapsed.
- **Keep Canvas read-only compatibility**:
  - Shared replay views should never execute side effects; guard with `dataOverride` / `shareId`-style checks.
- **Give every panel an empty and loading state**:
  - Use `ArtifactLoadingState` to keep tone consistent.
- **Keyboard and ARIA**:
  - Add `aria-label` for icon-only buttons.
  - Ensure dialogs close on Escape and click-outside when safe.

---

## Replication appendix (pixel-identical spec)

This appendix is intentionally **prescriptive**. It is designed so an agent can rebuild the UI with the same geometry, layering, and motion even without re-reading every component.

If you only need a conceptual overview, read the main sections above. If you need pixel-identical reproduction, use this appendix.

### Replication checklist (pixel-identical)

- **Do not change Tailwind defaults**
  - This UI relies on Tailwind’s default `zinc` palette (e.g. `text-zinc-700`, `bg-zinc-50`) plus semantic CSS variables.
  - Changing Tailwind’s default colors, font sizes, radii, or breakpoints will cause visible drift.

- **Copy the global styling contract**
  - `src/app/globals.css` must contain:
    - Tailwind v4 CSS-first import
    - the `dark:` custom variant bound to `data-theme=dark`
    - the full `:root` + `[data-theme="dark"]` token blocks
    - glass / mac-window / button / animation utility classes

- **Keep the pre-paint boot scripts**
  - `src/app/layout.tsx` injects `themeInitScript` and `sidebarInitScript` into `<head>` to prevent theme/layout flashes.
  - Without these scripts, the UI will visibly “jump” on first paint (wrong theme, wrong sidebar width).

- **Honor the exact storage keys**
  - Theme preference: `tuna.theme` (localStorage + cookie)
  - Sidebar collapsed: `tuna.sidebar.collapsed` (localStorage + cookie + CSS var `--sidebar-width`)
  - Model preset: `tuna.modelPreset` (localStorage)
  - Resume chat id: `tuna.resumeChatId` (localStorage)

- **Replicate the desktop layout geometry**
  - Sidebar expanded width: **280px**
  - Sidebar collapsed width: **72px**
  - Desktop split view activates at **\(min-width: 1024px\)** and only when at least one Canvas panel is open.
  - Canvas pane width is resizable and clamped to **30%–70%**.

- **Replicate layering**
  - Use the z-index map below. The app depends on consistent layering (mobile sidebar, canvas modal, files drawer, settings/share modals).

### Exact design tokens (CSS variables)

Source-of-truth: `src/app/globals.css`.

#### Required Tailwind v4 + plugin wiring

```css
@import "tailwindcss";
@import "@fortune-sheet/react/dist/index.esm.css";
@plugin "@tailwindcss/typography";

/* Tailwind v4: make `dark:` utilities respond to our theme attribute */
@custom-variant dark (&&:where([data-theme=dark], [data-theme=dark] *));
```

#### Theme tokens (copy/paste exactly)

```css
:root {
  color-scheme: light;

  /* Light theme (default) */
  --bg-primary: 0 0% 99%;
  --bg-secondary: 0 0% 97%;
  --bg-tertiary: 0 0% 94%;
  --bg-elevated: 0 0% 100%;

  --text-primary: 222 20% 12%;
  --text-secondary: 222 12% 38%;
  --text-muted: 222 10% 52%;
  --text-subtle: 220 8% 70%;

  --border-default: 222 12% 15% / 0.08;
  --border-hover: 222 12% 15% / 0.14;
  --border-focus: 222 12% 15% / 0.24;

  --accent-violet: 262 83% 58%;
  --accent-purple: 280 83% 60%;
  --accent-blue: 217 91% 60%;
  --accent-green: 160 84% 39%;
  --accent-amber: 38 92% 50%;
  --accent-red: 0 84% 60%;
  --glow-color: 262 83% 58%;
  /* Keep for branding if needed */
  --accent-black: 0 0% 0%;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.05);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.05);

  --radius-sm: 0.375rem;
  --radius-md: 0.75rem;
  --radius-lg: 1rem;
  --radius-xl: 1.5rem;

  --backdrop-blur: 12px;
  --transition-fast: 150ms;
  --transition-normal: 250ms;
  --transition-slow: 400ms;
  --spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --logo-filter: none;

  /* Aliases (for `bg-[var(--background)]` etc.) */
  --background: hsl(var(--bg-primary));
  --foreground: hsl(var(--text-primary));
  --card: hsl(var(--bg-secondary));
  --card-foreground: hsl(var(--text-primary));
  --muted: hsl(var(--bg-tertiary));
  --muted-foreground: hsl(var(--text-muted));
  --border: hsl(var(--border-default));
}

[data-theme="dark"] {
  color-scheme: dark;
  /* Invert to make the black logotype readable, then hue-rotate to keep the teal accent close to brand. */
  --logo-filter: invert(1) hue-rotate(180deg) saturate(1.2) brightness(1.05) contrast(1.05);

  /* Dark theme */
  --bg-primary: 220 15% 12%;
  --bg-secondary: 220 14% 16%;
  /* Sidebar/Input */
  --bg-tertiary: 220 12% 22%;
  --bg-elevated: 220 14% 18%;

  --text-primary: 0 0% 96%;
  --text-secondary: 0 0% 84%;
  --text-muted: 0 0% 70%;
  --text-subtle: 0 0% 58%;

  --border-default: 0 0% 100% / 0.12;
  --border-hover: 0 0% 100% / 0.2;
  --border-focus: 0 0% 100% / 0.3;

  --accent-black: 0 0% 100%;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 30px rgba(0, 0, 0, 0.15);
  --shadow-glow: 0 0 40px rgba(139, 92, 246, 0.2);
}
```

#### Core utility classes used by the app (copy/paste exactly)

This UI frequently uses custom “semantic utilities” in addition to Tailwind. These must exist as-written.

```css
/* ===== Safe-area utilities (iOS notch / home indicator) ===== */
.safe-area-px {
  padding-left: max(1rem, env(safe-area-inset-left));
  padding-right: max(1rem, env(safe-area-inset-right));
}

.safe-area-py {
  padding-top: max(1rem, env(safe-area-inset-top));
  padding-bottom: max(1.25rem, env(safe-area-inset-bottom));
}

.safe-area-pt {
  padding-top: max(1rem, env(safe-area-inset-top));
}

.safe-area-pb {
  padding-bottom: max(1.25rem, env(safe-area-inset-bottom));
}

/* ===== Scrollbar hide utility ===== */
.scrollbar-hide {
  -ms-overflow-style: none; /* IE/Edge */
  scrollbar-width: none; /* Firefox */
}

.scrollbar-hide::-webkit-scrollbar {
  display: none; /* Chrome/Safari */
}

/* ===== Keyframes required by custom classes ===== */
@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }

  100% {
    background-position: 200% 0;
  }
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-8px);
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.6;
  }
}

@keyframes typingDot {
  0%,
  60%,
  100% {
    transform: translateY(0);
  }

  30% {
    transform: translateY(-6px);
  }
}

/* ===== Animation utility classes used throughout the app ===== */
.animate-shimmer {
  background: linear-gradient(
    90deg,
    hsl(var(--text-subtle)) 0%,
    hsl(var(--text-muted)) 50%,
    hsl(var(--text-subtle)) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

/* ===== Glass + Mac window metaphors ===== */
.glass {
  background: hsl(var(--bg-elevated) / 0.8);
  backdrop-filter: blur(var(--backdrop-blur));
  -webkit-backdrop-filter: blur(var(--backdrop-blur));
  border: 1px solid hsl(var(--border-default));
}

.glass-subtle {
  background: hsl(var(--bg-elevated) / 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid hsl(var(--border-default));
}

.glass-strong {
  background: hsl(var(--bg-elevated) / 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid hsl(var(--border-hover));
}

.glass-panel {
  background: hsl(var(--bg-secondary) / 0.78);
  border: 1px solid hsl(var(--border-default));
  border-radius: 24px;
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

.glass-panel-strong {
  background: hsl(var(--bg-secondary) / 0.9);
  border-color: hsl(var(--border-hover));
}

.glass-header {
  background: hsl(var(--bg-secondary) / 0.82);
  border-bottom: 1px solid hsl(var(--border-default));
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.glass-card {
  background: hsl(var(--bg-elevated) / 0.8);
  border: 1px solid hsl(var(--border-default));
  border-radius: 16px;
  box-shadow: var(--shadow-sm);
}

.macos-frame {
  position: relative;
  background: linear-gradient(
    180deg,
    hsl(var(--bg-secondary) / 0.92),
    hsl(var(--bg-secondary) / 0.75)
  );
  border: 1px solid hsl(var(--border-default));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 30px 80px -45px rgba(0, 0, 0, 0.6),
    0 10px 24px -18px rgba(0, 0, 0, 0.4);
}

.macos-titlebar {
  background: linear-gradient(
    180deg,
    hsl(var(--bg-secondary) / 0.98),
    hsl(var(--bg-secondary) / 0.72)
  );
  border-bottom: 1px solid hsl(var(--border-hover));
}

/* ===== Semantic color utilities (non-Tailwind helpers) ===== */
.text-primary {
  color: hsl(var(--text-primary));
}

.text-secondary {
  color: hsl(var(--text-secondary));
}

.text-muted {
  color: hsl(var(--text-muted));
}

.text-subtle {
  color: hsl(var(--text-subtle));
}

.border-default {
  border-color: hsl(var(--border-default));
}

.border-hover {
  border-color: hsl(var(--border-hover));
}

.border-focus {
  border-color: hsl(var(--border-focus));
}

.bg-primary {
  background: hsl(var(--bg-primary));
}

.bg-secondary {
  background: hsl(var(--bg-secondary));
}

.bg-tertiary {
  background: hsl(var(--bg-tertiary));
}

.bg-elevated {
  background: hsl(var(--bg-elevated));
}

/* ===== Buttons used across composer / modals ===== */
.btn-primary {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 20px;
  background: linear-gradient(135deg, hsl(var(--accent-violet)), hsl(var(--accent-purple)));
  color: white;
  font-weight: 500;
  border-radius: 12px;
  border: none;
  cursor: pointer;
  overflow: hidden;
  transition: all var(--transition-fast) var(--ease-out-expo);
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 20px hsl(var(--accent-violet) / 0.4);
}

.btn-primary:active {
  transform: translateY(0) scale(0.98);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 20px;
  background: hsl(var(--bg-tertiary));
  color: hsl(var(--text-primary));
  font-weight: 500;
  border-radius: 12px;
  border: 1px solid hsl(var(--border-default));
  cursor: pointer;
  transition: all var(--transition-fast) var(--ease-out-expo);
}

.btn-secondary:hover {
  background: hsl(var(--bg-elevated));
  border-color: hsl(var(--border-hover));
  transform: translateY(-1px);
}

.btn-secondary:active {
  transform: translateY(0) scale(0.98);
}

.btn-send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: hsl(var(--text-primary));
  color: hsl(var(--bg-primary));
  border-radius: 50%;
  border: none;
  cursor: pointer;
  transition: all var(--transition-fast) var(--spring);
}

.btn-send:hover:not(:disabled) {
  transform: scale(1.08);
  box-shadow: 0 4px 15px hsl(var(--text-primary) / 0.3);
}

.btn-send:active:not(:disabled) {
  transform: scale(0.95);
}

.btn-send:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
```

**Note on “semantic colors with opacity”**:

- The UI code uses Tailwind-style opacity modifiers like `bg-secondary/90`, `bg-primary/70`, `bg-elevated/85`, `bg-tertiary/80`.
- If you are replicating this UI in an environment where those classes are not generated, convert them to explicit arbitrary values:
  - `bg-secondary/90` → `bg-[hsl(var(--bg-secondary)/0.9)]`
  - `bg-primary/70` → `bg-[hsl(var(--bg-primary)/0.7)]`
  - `bg-elevated/85` → `bg-[hsl(var(--bg-elevated)/0.85)]`
  - `bg-tertiary/80` → `bg-[hsl(var(--bg-tertiary)/0.8)]`

### Breakpoints and responsive rules (exact)

#### Tailwind default breakpoints (assumed by the UI)

- `sm`: 640px
- `md`: 768px
- `lg`: 1024px
- `xl`: 1280px
- `2xl`: 1536px

#### App-specific responsive rules

- **Split view gate** (`src/app/[[...chatId]]/page.tsx`)
  - `isLgUp = useMediaQuery("(min-width: 1024px)")`
  - `isSplitView = openPanels.length > 0 && isLgUp`
  - Meaning: Canvas appears as a right pane only at `lg` and only when at least one panel is open.

- **Sidebar behavior**
  - Desktop sidebar wrapper: `hidden md:block` (sidebar is always present at `md` and up)
  - Mobile sidebar becomes a modal drawer: `fixed inset-0 z-[80] md:hidden`

- **Top bars**
  - Mobile top bar is visible only below `md`: `md:hidden`
  - Desktop chat header is visible only at `md` and up: `hidden md:block`

- **Main shell rounding and border**
  - Main `<main>` becomes an inset “window” only at `md` and up:
    - `m-0` (mobile) → `md:my-2 md:mr-2`
    - `rounded-none` (mobile) → `md:rounded-[2rem]`
    - `border-0` (mobile) → `md:border border-default`
    - `shadow-none` (mobile) → `md:shadow-2xl shadow-black/20`

### Z-index and layering map (exact)

This app uses explicit z-index values to guarantee predictable overlays.

| Layer | z-index | Where | Notes |
| --- | ---: | --- | --- |
| Context usage tooltip | `9999` | `ContextUsageIndicator` | `pointer-events-none`, fixed-position |
| Model selector dropdown | `60` | `renderModelSelector()` | Absolute menu: `z-[60]` |
| Sidebar search modal | `60` | `Sidebar.tsx` | Full-screen overlay: `fixed inset-0 z-[60]` |
| Delete chat confirm | `50` | `Sidebar.tsx` | `fixed inset-0 z-50` |
| Split-view resize handle | `50` | `ChatShell` | `relative ... z-50` |
| Sidebar base | `20` | `Sidebar.tsx` | `motion.aside ... z-20` |
| Mobile sidebar drawer | `80` | `ChatShell` | `fixed inset-0 z-[80] md:hidden` |
| Landing overlay | `30` | `ChatShell` | `absolute inset-0 z-30` |
| Chat loading overlay | `30` | `ChatShell` | `absolute inset-0 z-30` inside message list |
| Mobile canvas modal | `90` | `ChatShell` | `fixed inset-0 z-[90]` |
| Files drawer | `95` | `FilesDrawer.tsx` | `fixed inset-0 z-[95]` |
| Share modal | `100` | `ShareChatModal.tsx` | `fixed inset-0 z-[100]` |
| Credits modal | `100` | `CreditsModal.tsx` | `fixed inset-0 z-[100]` |
| Nested integration/mcp modals | `120` | `CreditsModal.tsx` | `fixed inset-0 z-[120]` |

### Component blueprints (exact class recipes)

All class strings below are copied from the implementation. If you want the UI to match exactly, keep these verbatim.

#### Root layout and pre-paint boot (`src/app/layout.tsx`)

- `<html>`:
  - `lang="en"`
  - `className="h-full"`
  - `suppressHydrationWarning`
- `<head>`:
  - injects `themeInitScript` and `sidebarInitScript` via `dangerouslySetInnerHTML`
- `<body>`:
  - `className="\${nunitoSans.variable} font-sans antialiased min-h-dvh"`

Pre-paint scripts (copy/paste exactly):

```ts
// themeInitScript (sets documentElement[data-theme] before hydration)
const themeInitScript = `
(() => {
  try {
    var key = "tuna.theme";
    var pref = null;
    try {
      pref = window.localStorage.getItem(key);
    } catch (e) {}
    if (!pref) {
      try {
        var part = document.cookie
          .split("; ")
          .find(function (p) {
            return p.indexOf(key + "=") === 0;
          });
        if (part) pref = part.split("=")[1];
      } catch (e) {}
    }
    if (pref !== "dark" && pref !== "light" && pref !== "system") pref = null;
    var resolveSystem = function () {
      try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
          return "dark";
        }
      } catch (e) {}
      return "light";
    };
    var apply = function (theme) {
      document.documentElement.setAttribute("data-theme", theme);
    };
    var theme = pref === "dark" || pref === "light" ? pref : pref === "system" ? resolveSystem() : "light";
    apply(theme);
    // Keep the resolved theme synced to OS changes when in "system" mode.
    if (pref === "system") {
      try {
        var mql = window.matchMedia("(prefers-color-scheme: dark)");
        var onChange = function (e) {
          apply(e && e.matches ? "dark" : "light");
        };
        if (mql && typeof mql.addEventListener === "function") {
          mql.addEventListener("change", onChange);
        } else if (mql && typeof mql.addListener === "function") {
          mql.addListener(onChange);
        }
      } catch (e) {}
    }
  } catch (e) {}
})();
`;

// sidebarInitScript (sets data-sidebar-collapsed + --sidebar-width before hydration)
const sidebarInitScript = `
(() => {
  try {
    var key = "tuna.sidebar.collapsed";
    var stored = null;
    try {
      stored = window.localStorage.getItem(key);
    } catch (e) {}
    if (stored == null) {
      try {
        var part = document.cookie
          .split("; ")
          .find(function (p) {
            return p.indexOf(key + "=") === 0;
          });
        if (part) stored = decodeURIComponent(part.split("=")[1] || "");
      } catch (e) {}
    }
    var isCollapsed = stored === "1" || stored === "true";
    var root = document.documentElement;
    root.setAttribute("data-sidebar-collapsed", isCollapsed ? "1" : "0");
    root.style.setProperty("--sidebar-width", isCollapsed ? "72px" : "280px");
  } catch (e) {}
})();
`;
```

#### Chat shell root (`src/app/[[...chatId]]/page.tsx`)

Top-level layout:

```tsx
<ArtifactScopeProvider scopeId={artifactScopeId} chatId={artifactChatId}>
  <div className="h-dvh flex overflow-hidden bg-primary">
    {/* Desktop sidebar wrapper */}
    <div className="hidden md:block">…</div>

    {/* Mobile sidebar drawer */}
    {/* fixed inset-0 z-[80] md:hidden */}

    <main className="flex-1 flex flex-col relative overflow-hidden transition-all duration-300 m-0 md:my-2 md:mr-2 rounded-none md:rounded-[2rem] border-0 md:border border-default shadow-none md:shadow-2xl bg-gradient-to-br from-[hsl(var(--bg-secondary))] to-[hsl(var(--bg-primary))] shadow-black/20">
      {/* Mobile top bar: md:hidden */}
      {/* Landing overlay: absolute inset-0 z-30 */}
      {/* Chat panels: hidden via opacity-0 pointer-events-none when landing */}
    </main>
  </div>
</ArtifactScopeProvider>
```

Key state gates:

- Landing state:
  - `showLanding = !isHistoryLoading && messages.length === 0`
  - chat panels container becomes `opacity-0 pointer-events-none` (so layout remains stable while landing overlays)
- Split view:
  - `isSplitView = openPanels.length > 0 && isLgUp` where `isLgUp` is `"(min-width: 1024px)"`

#### Mobile top bar (exact classes)

- Wrapper: `md:hidden flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3`
- Sidebar open button: `p-2.5 rounded-full transition-colors bg-tertiary hover:bg-elevated text-primary`

#### Model selector (exact)

Presets:

- `"tuna_1_fast"` → label `"Tuna 1.0"` (reasoning effort `"low"`)
- `"tuna_1"` → label `"Tuna 1.0 Thinking"` (reasoning effort `"medium"`)
- `"tuna_1_high"` → label `"Tuna 1.0 Max"` (reasoning effort `"xhigh"`)

Trigger button:

```txt
inline-flex items-center gap-2 px-0 py-1 text-[15px] sm:text-[16px] tracking-tight transition-colors
  dark: text-white hover:text-white/90
  light: text-zinc-900 hover:text-zinc-700
```

Dropdown menu container:

```txt
absolute left-0 mt-2 w-[260px] rounded-2xl border border-default shadow-xl overflow-hidden z-[60] bg-elevated text-primary shadow-black/25
```

#### Context usage ring (exact)

- Rendered only when `contextUsage?.maxInputTokens` exists.
- SVG ring parameters:
  - `size = 18`, `stroke = 2`
  - track: `rgba(255,255,255,0.18)` (dark) / `rgba(0,0,0,0.14)` (light)
  - progress:
    - near limit (`>= 0.95`): `rgba(251,191,36,0.95)` (dark) / `rgb(217,119,6)` (light)
    - otherwise: `rgba(255,255,255,0.85)` (dark) / `rgba(24,24,27,0.9)` (light)
- Button class:
  - `h-9 w-9 rounded-full grid place-items-center transition-colors`
  - `dark: hover:bg-white/5 text-white/70`
  - `light: hover:bg-black/5 text-zinc-700`
- Tooltip container (fixed): `pointer-events-none z-[9999] whitespace-nowrap rounded-md px-2 py-1 text-[11px] shadow-sm border …`

#### Chat messages list (exact)

- Messages scroller: `relative flex-1 overflow-y-auto px-4 sm:px-6 py-2 space-y-0 scrollbar-hide`
- Width cap:
  - Not split: wrapper includes `max-w-3xl`
  - Split: wrapper switches to `max-w-full`

#### Message row container + bubbles (exact)

Row entrance motion:

- `initial={{ opacity: 0, y: 10 }}`
- `animate={{ opacity: 1, y: 0 }}`

Row wrapper:

- `className={\`flex \${message.role === 'user' ? 'justify-end' : 'justify-start'} \${rowSpacingClass} last:mb-0\`}`

Bubble classes (primary cases):

- User bubble:
  - `max-w-[85%] rounded-[24px] px-5 pt-4 pb-3.5 text-[15px] leading-relaxed bg-tertiary text-primary`
- Assistant normal bubble:
  - `max-w-[85%] rounded-[24px] px-5 py-3.5 text-[15px] leading-relaxed bg-transparent pl-0 text-zinc-800 dark:text-zinc-300`
- Artifact message container (card instead of prose):
  - `w-full max-w-[85%] bg-transparent px-0 py-0`

Reasoning + trace preview limits (UI contract):

- `REASONING_PREVIEW_LIMIT = 140`
- `TRACE_PREVIEW_LIMIT = 140`

#### In-chat composer (exact)

Outer padding: `px-4 sm:px-6 pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)] shrink-0`

Composer glass card:

- `rounded-[24px] sm:rounded-[32px] p-2.5 sm:p-3 transition-all duration-300 relative border border-default bg-elevated/85 dark:bg-tertiary/80 backdrop-blur-xl shadow-sm`

Textarea:

- `flex-1 min-h-[44px] bg-transparent border-0 focus:ring-0 resize-none py-2.5 text-[16px] sm:text-[15px] max-h-32 placeholder:text-zinc-400 text-zinc-900 dark:text-zinc-100 disabled:opacity-60 disabled:cursor-not-allowed`

Send button:

- Wrapper:
  - `h-11 w-11 inline-flex items-center justify-center rounded-full transition-all duration-200 shrink-0`
- Enabled variant:
  - `bg-zinc-900 dark:bg-white text-white dark:text-black shadow-md hover:scale-105 active:scale-95`
- Disabled variant:
  - `bg-zinc-200 dark:bg-white/5 text-zinc-400 dark:text-white/20`

Thinking indicator delay + UI:

- `THINKING_INDICATOR_DELAY_MS = 450`
- Shown while `isTyping && showThinkingIndicator` with:
  - `flex items-center gap-2 pl-4 py-2 opacity-50`
  - label `text-xs text-zinc-500 dark:text-zinc-400`
  - three bouncing dots: `w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce …`

#### Desktop Canvas (split view) container (exact)

Resize handle:

- `relative w-2.5 h-full cursor-col-resize flex items-center justify-center transition-colors z-50 group shrink-0`
- bar: `h-20 w-1.5 rounded-full bg-zinc-200/70 dark:bg-white/10 group-hover:bg-zinc-300/80 dark:group-hover:bg-white/20 transition-colors`

Canvas outer wrapper:

- `className="relative h-full py-4 pr-4 pl-2"`
- width animates to `\`\${canvasWidth}%\`` with:
  - `duration: isResizing ? 0 : 0.6`
  - `ease: [0.19, 1, 0.22, 1]`

Canvas window:

- `h-full w-full rounded-[28px] overflow-hidden flex flex-col relative glass-panel macos-frame`
- When dark: add `glass-panel-strong`

Titlebar:

- `h-14 flex items-center px-5 shrink-0 gap-3 relative glass-header macos-titlebar`
- Mac dots:
  - red close (only if closable): `w-3 h-3 rounded-full bg-red-400/90 hover:bg-red-500 …`
  - amber/yellow: `w-3 h-3 rounded-full bg-amber-400/90 …`
  - green: `w-3 h-3 rounded-full bg-green-400/90 …`
- Title centered:
  - container: `absolute inset-0 flex items-center justify-center pointer-events-none`
  - text: `text-[13px] font-semibold tracking-tight` + theme color

Canvas content region:

- `relative flex-1 overflow-y-auto bg-primary/70 p-2 sm:p-3`
- Timeline bar boundary: `border-t border-black/5 dark:border-white/10`

#### Mobile Canvas modal (exact)

- Overlay: `fixed inset-0 z-[90]`
- Backdrop: `absolute inset-0 bg-black/40 backdrop-blur-sm` (click closes)
- Sheet container:
  - `absolute inset-0 flex flex-col bg-secondary/90`
  - enter/exit: spring `stiffness: 260`, `damping: 30`
- Header:
  - `shrink-0 flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 relative glass-header`
- Body:
  - `relative flex-1 min-h-0 overflow-y-auto bg-primary/70 p-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]`

#### Sidebar shell (exact) (`src/components/Sidebar.tsx`)

Sidebar container (motion + classes):

- `motion.aside` variants:
  - expanded: `{ width: 280 }`
  - collapsed: `{ width: 72 }`
  - transition: `{ type: "spring", stiffness: 280, damping: 32, mass: 0.8 }`
- Base class:
  - `h-dvh flex flex-col relative z-20 shrink-0 bg-secondary text-primary`
- Additional when collapsed:
  - `cursor-col-resize`
  - `overflow-visible` (expanded uses `overflow-hidden`)

Search modal overlay (Cmd/Ctrl+K):

- Overlay: `fixed inset-0 z-[60] flex items-start justify-center p-4 sm:p-6` + `bg-black/60` (dark) or `bg-black/20` (light) + `backdrop-blur-sm`
- Dialog: `mt-[10vh] w-full max-w-[640px] rounded-2xl border border-default shadow-2xl overflow-hidden bg-elevated text-primary shadow-black/25`

Delete chat confirm modal:

- Overlay: `fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm`
- Dialog: `w-[92%] max-w-sm rounded-2xl border border-default p-5 shadow-2xl bg-elevated text-primary shadow-black/25`

#### Files drawer / Credits / Share modals (exact shells)

Files drawer (`src/app/components/ui/FilesDrawer.tsx`):

- Overlay: `fixed inset-0 z-[95] flex items-center justify-center p-4 … backdrop-blur-sm`
- Panel: `w-[min(1100px,96vw)] h-[min(820px,90vh)] … rounded-[28px] …`
- Motion: spring `{ stiffness: 420, damping: 38, mass: 0.9 }` with `{ y: 18, opacity: 0, scale: 0.985 }` → `{ y: 0, opacity: 1, scale: 1 }`

Credits modal (`src/app/components/ui/CreditsModal.tsx`):

- Overlay: `fixed inset-0 z-[100] flex items-start justify-center p-0 sm:p-6 … backdrop-blur-sm`
- Panel: `w-full max-w-[880px] … h-dvh rounded-none … sm:mt-[8vh] sm:h-[82dvh] sm:rounded-2xl sm:border …`
- Nested integration/mcp modals: `fixed inset-0 z-[120] … bg-black/60 …`

Share modal (`src/app/components/ui/ShareChatModal.tsx`):

- Overlay: `fixed inset-0 z-[100] flex items-start justify-center p-4 sm:p-6 … backdrop-blur-sm`
- Panel: `mt-[10vh] w-full max-w-[520px] rounded-2xl border border-default shadow-2xl overflow-hidden bg-elevated text-primary shadow-black/25`

### Motion constants (Framer and CSS)

Use these values to match the “feel” exactly:

- **Sidebar collapse/expand**
  - `transition={{ type: "spring", stiffness: 280, damping: 32, mass: 0.8 }}`
- **Sidebar internal layout motion**
  - `transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.6 }}` (top nav container)
  - Toggle icon: `transition={{ duration: 0.16, ease: [0.19, 1, 0.22, 1] }}`
- **Global modal overlays**
  - Search modal overlay: duration `0.14`, ease `[0.19, 1, 0.22, 1]`
  - Search modal panel: duration `0.18`, ease `[0.19, 1, 0.22, 1]`
  - Credits/Share modals use the same 0.14 / 0.18 with the same ease.
- **Landing placeholder rotation**
  - Placeholder index changes every `4500ms`
  - Placeholder text transition: duration `0.6`, ease `[0.22, 1, 0.36, 1]`, y from `8` to `0`
- **Message entrance**
  - `initial={{ opacity: 0, y: 10 }}` → `animate={{ opacity: 1, y: 0 }}`
- **Split-view Canvas**
  - Pane width transition: duration `0.6` (or `0` while dragging), ease `[0.19, 1, 0.22, 1]`
- **Mobile Canvas modal**
  - `transition={{ type: "spring", stiffness: 260, damping: 30 }}`

### Keyboard shortcuts (exact)

- **Chat search**
  - Cmd/Ctrl+K opens the sidebar search modal (`Sidebar.tsx`).
- **Escape**
  - Closes: model selector menu, sidebar search, delete confirmation, files drawer, credits modal, share modal, mobile drawers.
- **Composer**
  - Enter sends (when allowed); Shift+Enter inserts newline.
  - When queued sends exist and input is empty, the UI hints: “Press Enter again to send now”.

