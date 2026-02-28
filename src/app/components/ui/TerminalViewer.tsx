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
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#c9d1d9",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

const ERROR_THEME = {
  ...BASE_THEME,
  foreground: "#ffa198",
  cursor: "#ff7b72",
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
  const lastRenderedContentRef = useRef("");
  const isWritingRef = useRef(false);
  const disposedRef = useRef(false);
  const pendingWriteRef = useRef<string | null>(null);

  const doFit = useCallback(() => {
    const fitAddon = fitRef.current;
    if (!fitAddon || disposedRef.current) return;
    try {
      fitAddon.fit();
    } catch {
      // ignore fit errors during layout churn
    }
  }, []);

  const writeIncremental = useCallback(() => {
    if (disposedRef.current) return;
    const term = terminalRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon) return;
    if (isWritingRef.current) return;

    const nextContent = pendingWriteRef.current;
    if (nextContent === null) return;
    pendingWriteRef.current = null;

    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = fitAddon.proposeDimensions?.();
    } catch {
      return;
    }
    if (!proposed || proposed.cols < MIN_RENDER_COLS || proposed.rows < MIN_RENDER_ROWS) return;

    const prev = lastRenderedContentRef.current;

    if (nextContent.startsWith(prev) && prev.length > 0) {
      const delta = nextContent.slice(prev.length);
      if (delta) {
        isWritingRef.current = true;
        try {
          term.write(delta, () => {
            isWritingRef.current = false;
            if (disposedRef.current) return;
            lastRenderedContentRef.current = nextContent;
            doFit();
            if (pendingWriteRef.current !== null) {
              queueMicrotask(() => writeIncremental());
            }
          });
        } catch {
          isWritingRef.current = false;
        }
      } else {
        lastRenderedContentRef.current = nextContent;
      }
    } else {
      isWritingRef.current = true;
      try {
        doFit();
        term.reset();
        term.write(nextContent, () => {
          isWritingRef.current = false;
          if (disposedRef.current) return;
          lastRenderedContentRef.current = nextContent;
          try {
            doFit();
            term.refresh(0, Math.max(term.rows - 1, 0));
          } catch {
            // ignore
          }
          if (pendingWriteRef.current !== null) {
            queueMicrotask(() => writeIncremental());
          }
        });
      } catch {
        isWritingRef.current = false;
      }
    }
  }, [doFit]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;

    const term = new Terminal({
      theme: BASE_THEME,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      letterSpacing: 0,
      disableStdin: true,
      convertEol: true,
      scrollback: 5000,
      cursorBlink: showCursor,
      cursorStyle: "block",
      cursorInactiveStyle: "block",
      smoothScrollDuration: 100,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    installSafeXtermDimensions(term);

    let raf = 0;
    let tries = 0;
    const scheduleFit = () => {
      if (disposedRef.current) return;
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        if (disposedRef.current) return;
        tries += 1;
        try {
          fitAddon.fit();
        } catch {
          // ignore
        }
        writeIncremental();
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
        .catch(() => {});
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
      terminalRef.current = null;
      fitRef.current = null;
      pendingWriteRef.current = null;
      lastRenderedContentRef.current = "";
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
  }, [showCursor, writeIncremental]);

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
    pendingWriteRef.current = content;
    writeIncremental();
  }, [content, writeIncremental]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "terminal-viewer h-full min-h-[200px] w-full overflow-hidden rounded-xl border border-default bg-[#0d1117]",
        showCursor ? "terminal-viewer--cursor" : null,
        className
      )}
    />
  );
}
