"use client";

/**
 * useConnectionManager – centralized connection, visibility, and cross-tab sync management.
 *
 * Responsibilities:
 * 1. Track online/offline status with events.
 * 2. Track document visibility (hidden / visible).
 * 3. Fire callbacks on visibility restore so consumers can refresh stale data.
 * 4. Provide a BroadcastChannel wrapper for cross-tab state sync.
 * 5. Expose helpers for smart polling with exponential backoff.
 */

import { useCallback, useEffect, useRef, useState, useMemo } from "react";

// ── Cross-tab broadcast ─────────────────────────────────────────────────────

const BROADCAST_CHANNEL_NAME = "tuna-sync";

export type SyncEventType =
  | "chat-updated"       // A chat's messages changed (from stream completion or DB write)
  | "chat-created"       // A new chat was created
  | "chat-deleted"       // A chat was deleted
  | "run-completed"      // An agent run finished
  | "run-started"        // An agent run started
  | "credits-changed"    // Credit balance changed
  | "force-refresh";     // Force all tabs to refresh

export type SyncEvent = {
  type: SyncEventType;
  chatId?: string;
  runId?: string;
  timestamp: number;
  tabId: string;
};

// Stable tab identity for deduplication
const TAB_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

let _sharedChannel: BroadcastChannel | null = null;

function getSharedChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!_sharedChannel) {
    try {
      _sharedChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    } catch {
      return null;
    }
  }
  return _sharedChannel;
}

/**
 * Broadcast a sync event to all other tabs.
 * Safe to call from anywhere – silently no-ops if BroadcastChannel is unsupported.
 */
export function broadcastSync(
  type: SyncEventType,
  payload?: { chatId?: string; runId?: string }
): void {
  const ch = getSharedChannel();
  if (!ch) return;
  try {
    const event: SyncEvent = {
      type,
      chatId: payload?.chatId,
      runId: payload?.runId,
      timestamp: Date.now(),
      tabId: TAB_ID,
    };
    ch.postMessage(event);
  } catch {
    // Channel may be closed; ignore.
  }
}

// ── Smart polling helper ────────────────────────────────────────────────────

export type SmartPollOptions = {
  /** Base interval in ms (default: 2500) */
  baseInterval?: number;
  /** Max interval in ms when backing off (default: 30000) */
  maxInterval?: number;
  /** Max consecutive errors before giving up (0 = never give up, default: 0) */
  maxErrors?: number;
  /** Whether to pause when document is hidden (default: true) */
  pauseWhenHidden?: boolean;
  /** Whether to run immediately on start (default: true) */
  immediate?: boolean;
};

export type SmartPollController = {
  start: () => void;
  stop: () => void;
  /** Signal a successful poll (resets backoff) */
  success: () => void;
  /** Signal a failed poll (increases backoff) */
  failure: () => void;
  /** Force an immediate poll */
  forceNow: () => void;
};

/**
 * Creates a smart polling controller with exponential backoff, visibility awareness,
 * and online/offline handling.
 */
export function createSmartPoll(
  fn: () => void | Promise<void>,
  options?: SmartPollOptions
): SmartPollController {
  const baseInterval = options?.baseInterval ?? 2500;
  const maxInterval = options?.maxInterval ?? 30_000;
  const maxErrors = options?.maxErrors ?? 0;
  const pauseWhenHidden = options?.pauseWhenHidden ?? true;
  const immediate = options?.immediate ?? true;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveErrors = 0;
  let running = false;
  let paused = false;

  const getDelay = () => {
    if (consecutiveErrors === 0) return baseInterval;
    // Exponential backoff: base * 2^errors, capped at maxInterval
    return Math.min(baseInterval * Math.pow(2, consecutiveErrors), maxInterval);
  };

  const schedule = () => {
    if (!running || paused) return;
    if (timer !== null) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!running || paused) return;
      try {
        await fn();
      } catch {
        // fn itself should handle errors; this is a safety net
      }
      schedule();
    }, getDelay());
  };

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const handleVisibility = () => {
    if (!pauseWhenHidden || !running) return;
    if (document.hidden) {
      paused = true;
      clear();
    } else {
      paused = false;
      // Run immediately on visibility restore, then resume schedule
      void (async () => {
        try {
          await fn();
        } catch {
          // ignore
        }
        schedule();
      })();
    }
  };

  const handleOnline = () => {
    if (!running) return;
    // Reset backoff on reconnect
    consecutiveErrors = 0;
    paused = false;
    clear();
    // Immediate poll on reconnect
    void (async () => {
      try {
        await fn();
      } catch {
        // ignore
      }
      schedule();
    })();
  };

  const handleOffline = () => {
    if (!running) return;
    paused = true;
    clear();
  };

  return {
    start() {
      if (running) return;
      running = true;
      paused = false;
      consecutiveErrors = 0;

      if (pauseWhenHidden) {
        document.addEventListener("visibilitychange", handleVisibility);
      }
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);

      if (immediate) {
        void (async () => {
          try {
            await fn();
          } catch {
            // ignore
          }
          schedule();
        })();
      } else {
        schedule();
      }
    },

    stop() {
      running = false;
      paused = false;
      clear();
      consecutiveErrors = 0;
      if (pauseWhenHidden) {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    },

    success() {
      consecutiveErrors = 0;
    },

    failure() {
      consecutiveErrors++;
      if (maxErrors > 0 && consecutiveErrors >= maxErrors) {
        this.stop();
      }
    },

    forceNow() {
      clear();
      void (async () => {
        try {
          await fn();
        } catch {
          // ignore
        }
        if (running && !paused) {
          schedule();
        }
      })();
    },
  };
}

// ── React hook ──────────────────────────────────────────────────────────────

export type ConnectionState = {
  /** Whether the browser reports as online */
  isOnline: boolean;
  /** Whether the document/tab is visible */
  isVisible: boolean;
  /** Stable identifier for this tab */
  tabId: string;
};

export type ConnectionManagerCallbacks = {
  /** Called when the tab becomes visible after being hidden */
  onVisibilityRestore?: () => void;
  /** Called when the browser goes back online */
  onOnline?: () => void;
  /** Called when the browser goes offline */
  onOffline?: () => void;
  /** Called when a sync event is received from another tab */
  onSyncEvent?: (event: SyncEvent) => void;
};

/**
 * Hook for managing connection state, visibility, and cross-tab sync.
 *
 * Usage:
 * ```tsx
 * const { isOnline, isVisible } = useConnectionManager({
 *   onVisibilityRestore: () => refreshData(),
 *   onOnline: () => reconnect(),
 *   onSyncEvent: (event) => {
 *     if (event.type === "chat-updated" && event.chatId === currentChatId) {
 *       reloadMessages();
 *     }
 *   },
 * });
 * ```
 */
export function useConnectionManager(callbacks?: ConnectionManagerCallbacks): ConnectionState {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isVisible, setIsVisible] = useState(() =>
    typeof document !== "undefined" ? !document.hidden : true
  );

  // Use refs for callbacks to avoid re-subscribing on every render
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Track whether we were previously hidden (to detect restore)
  const wasHiddenRef = useRef(false);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const hidden = document.hidden;
      setIsVisible(!hidden);

      if (hidden) {
        wasHiddenRef.current = true;
      } else if (wasHiddenRef.current) {
        wasHiddenRef.current = false;
        callbacksRef.current?.onVisibilityRestore?.();
      }
    };

    const handleOnline = () => {
      setIsOnline(true);
      callbacksRef.current?.onOnline?.();
    };

    const handleOffline = () => {
      setIsOnline(false);
      callbacksRef.current?.onOffline?.();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Cross-tab sync listener
  useEffect(() => {
    const ch = getSharedChannel();
    if (!ch) return;

    const handler = (event: MessageEvent<SyncEvent>) => {
      const data = event.data;
      // Ignore events from this tab
      if (data?.tabId === TAB_ID) return;
      callbacksRef.current?.onSyncEvent?.(data);
    };

    ch.addEventListener("message", handler);
    return () => {
      ch.removeEventListener("message", handler);
    };
  }, []);

  return useMemo(() => ({ isOnline, isVisible, tabId: TAB_ID }), [isOnline, isVisible]);
}
