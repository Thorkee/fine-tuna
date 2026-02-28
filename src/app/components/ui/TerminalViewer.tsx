"use client";

import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { cn } from "@/lib/utils";

type TerminalViewerProps = {
  content: string;
  className?: string;
  variant?: "default" | "error";
  showCursor?: boolean;
};

const BASE_THEME = {
  background: "#0f1115",
  foreground: "#d6dae1",
  cursor: "#9ba3af",
  selectionBackground: "#1f2632",
};

const ERROR_THEME = {
  ...BASE_THEME,
  foreground: "#f2b8b5",
};

const FALLBACK_DIMENSIONS = {
  css: {
    canvas: { width: 0, height: 0 },
    cell: { width: 1, height: 1 },
  },
  device: {
    canvas: { width: 0, height: 0 },
    cell: { width: 1, height: 1 },
    char: { width: 1, height: 1, top: 0, left: 0 },
  },
} as const;

const MIN_RENDER_COLS = 8;
const MIN_RENDER_ROWS = 2;

type InternalRenderService = {
  __safeDimensionsInstalled?: boolean;
};

type InternalCore = {
  _renderService?: InternalRenderService;
};

/**
 * xterm v6 uses a non-null assertion for `RenderService.dimensions` and can throw
 * if a late render/refresh callback runs after disposal (renderer cleared).
 * Patch the instance to return the last known dimensions instead of throwing.
 */
function installSafeXtermDimensions(term: Terminal) {
  const core = (term as unknown as { _core?: InternalCore })._core;
  const renderService = core?._renderService;
  if (!renderService || renderService.__safeDimensionsInstalled) return;

  const proto = Object.getPrototypeOf(renderService);
  const desc = Object.getOwnPropertyDescriptor(proto, "dimensions");
  const originalGet = desc?.get as (() => unknown) | undefined;
  if (!originalGet) return;

  let last: unknown = null;
  Object.defineProperty(renderService, "dimensions", {
    configurable: true,
    get() {
      try {
        const dims = originalGet.call(this);
        last = dims;
        return dims;
      } catch {
        return last ?? FALLBACK_DIMENSIONS;
      }
    },
  });

  renderService.__safeDimensionsInstalled = true;
}

export default function TerminalViewer({
  content,
  className,
  variant = "default",
  showCursor = false,
}: TerminalViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const flushContentRef = useRef<() => void>(() => {});
  const pendingContentRef = useRef<string | null>(null);
  const lastRenderedContentRef = useRef("");
  const reflowRequestedRef = useRef(false);
  const isWritingRef = useRef(false);
  const disposedRef = useRef(false);

  const flushContent = useCallback(() => {
    if (disposedRef.current) return;
    const term = terminalRef.current;
    const fitAddon = fitRef.current;
    const container = containerRef.current;
    if (!term || !fitAddon || !container) return;
    if (isWritingRef.current) return;

    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = fitAddon.proposeDimensions?.();
    } catch {
      // xterm may throw if renderer is temporarily unavailable (eg. during teardown)
      return;
    }
    if (!proposed || proposed.cols < MIN_RENDER_COLS || proposed.rows < MIN_RENDER_ROWS) return;

    const pending = pendingContentRef.current;
    const hasPending = pending !== null;
    const shouldReflow = reflowRequestedRef.current && !hasPending;
    const nextContent = hasPending ? pending : shouldReflow ? lastRenderedContentRef.current : null;
    if (nextContent === null) return;
    pendingContentRef.current = null;
    reflowRequestedRef.current = false;
    isWritingRef.current = true;

    try {
      fitAddon.fit();
    } catch {
      // ignore fit errors during layout churn
    }

    try {
      term.reset();
      term.write(nextContent, () => {
        isWritingRef.current = false;
        if (disposedRef.current) return;
        if (terminalRef.current !== term) return;
        lastRenderedContentRef.current = nextContent;
        try {
          const beforeCols = term.cols;
          const beforeRows = term.rows;
          fitAddon.fit();
          if (
            (term.cols !== beforeCols || term.rows !== beforeRows) &&
            pendingContentRef.current === null &&
            nextContent.length > 0
          ) {
            reflowRequestedRef.current = true;
          }
          term.refresh(0, Math.max(term.rows - 1, 0));
        } catch {
          // ignore
        }
        if (pendingContentRef.current !== null || reflowRequestedRef.current) {
          queueMicrotask(() => flushContentRef.current());
        }
      });
    } catch {
      isWritingRef.current = false;
    }
  }, []);

  useEffect(() => {
    flushContentRef.current = flushContent;
  }, [flushContent]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;

    const term = new Terminal({
      theme: BASE_THEME,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      lineHeight: 1.35,
      disableStdin: true,
      convertEol: true,
      scrollback: 2000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    installSafeXtermDimensions(term);
    // Fit can run before layout settles (width=0 → MINIMUM_COLS=2).
    // Schedule a few fits until the container has real size.
    let raf = 0;
    let tries = 0;
    const scheduleFit = () => {
      if (disposedRef.current) return;
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        if (disposedRef.current) return;
        tries += 1;
        const prevCols = term.cols;
        const prevRows = term.rows;
        try {
          fitAddon.fit();
        } catch {
          // ignore fit errors during teardown
        }
        if (
          (term.cols !== prevCols || term.rows !== prevRows) &&
          pendingContentRef.current === null &&
          lastRenderedContentRef.current.length > 0
        ) {
          reflowRequestedRef.current = true;
        }
        flushContent();
        const rect = container.getBoundingClientRect();
        const tooSmall = rect.width < 80 || rect.height < 80;
        if (tooSmall && tries < 10) {
          scheduleFit();
        }
      });
    };
    scheduleFit();
    if (document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (disposedRef.current) return;
          scheduleFit();
        })
        .catch(() => {
          // ignore font readiness errors
        });
    }

    terminalRef.current = term;
    fitRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(container);

    return () => {
      disposedRef.current = true;
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      // Make any pending microtasks/RAF no-op before disposal.
      terminalRef.current = null;
      fitRef.current = null;
      pendingContentRef.current = null;
      lastRenderedContentRef.current = "";
      reflowRequestedRef.current = false;
      isWritingRef.current = false;
      try {
        fitAddon.dispose();
      } catch {
        // ignore
      }
      try {
        term.dispose();
      } catch {
        // ignore
      }
    };
  }, [flushContent]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    try {
      term.options.theme = variant === "error" ? ERROR_THEME : BASE_THEME;
    } catch {
      // ignore theme updates during teardown
    }
  }, [variant]);

  useEffect(() => {
    pendingContentRef.current = content;
    flushContent();
  }, [content, flushContent]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "terminal-viewer h-full min-h-[200px] w-full overflow-hidden rounded-xl border border-default bg-[#0f1115]",
        showCursor ? "terminal-viewer--cursor" : null,
        className
      )}
    />
  );
}
