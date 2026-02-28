"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Globe,
  Info,
  Link as LinkIcon,
  Linkedin,
  Loader2,
  MessageCircle,
  Share2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";

type ShareCreateResponse = { shareId?: string; url?: string; error?: string };

type PreviewMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

const ARTIFACT_MESSAGE_PREFIX = "__TUNA_ARTIFACT__:";

/**
 * SVG icon for X / Twitter brand.
 * Using an inline SVG avoids the confusion of reusing Lucide's `X` (close) icon.
 */
function XTwitterIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export default function ShareChatModal(props: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  chatTitle?: string;
  previewMessages?: PreviewMessage[];
  isDark?: boolean;
}) {
  const { open, onClose, chatId, chatTitle, previewMessages = [], isDark = false } = props;

  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // Reset per-open so a new share is created each time.
    setShareUrl(null);
    setIsCreating(false);
    setError(null);
    setCopiedAt(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  useEffect(() => {
    if (!copiedAt) return;
    const t = window.setTimeout(() => setCopiedAt(null), 2000);
    return () => window.clearTimeout(t);
  }, [copiedAt]);

  const ensureShareUrl = useCallback(async () => {
    if (shareUrl) return shareUrl;
    if (!chatId) throw new Error("Missing chat id");
    setIsCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ chatId }),
      });
      const json: ShareCreateResponse | null = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error || `Failed to create share (${res.status})`);
      }
      const url = typeof json?.url === "string" ? json.url : "";
      if (!url) throw new Error("Share URL missing from response");
      const absolute = new URL(url, window.location.origin).toString();
      setShareUrl(absolute);
      return absolute;
    } finally {
      setIsCreating(false);
    }
  }, [chatId, shareUrl]);

  useEffect(() => {
    if (!open) return;
    // Pre-create the share link so social share buttons can open synchronously (avoids popup blockers).
    void ensureShareUrl().catch((e) => {
      setError(e instanceof Error ? e.message : "Failed to create share link");
    });
  }, [ensureShareUrl, open]);

  const copyLink = useCallback(async () => {
    try {
      const url = await ensureShareUrl();
      await navigator.clipboard.writeText(url);
      setCopiedAt(Date.now());
      // Select the URL text for visual feedback
      urlInputRef.current?.select();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to copy link");
    }
  }, [ensureShareUrl]);

  const shareTo = useCallback(
    (kind: "x" | "linkedin" | "reddit") => {
      if (!shareUrl) return;
      const text = chatTitle ? `Check out: ${chatTitle}` : "";
      const share = (() => {
        switch (kind) {
          case "x":
            return `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}${text ? `&text=${encodeURIComponent(text)}` : ""}`;
          case "linkedin":
            return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`;
          case "reddit":
            return `https://www.reddit.com/submit?url=${encodeURIComponent(shareUrl)}${chatTitle ? `&title=${encodeURIComponent(chatTitle)}` : ""}`;
        }
      })();
      window.open(share, "_blank", "noopener,noreferrer");
    },
    [chatTitle, shareUrl]
  );

  const copied = Boolean(copiedAt);

  const title = (chatTitle || "").trim() || "Share chat";

  const preview = useMemo(() => {
    const candidates = Array.isArray(previewMessages) ? previewMessages : [];
    const filtered = candidates
      .filter((m) => m && typeof m === "object")
      .filter((m) => (m.role === "user" || m.role === "assistant"))
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : undefined,
        role: m.role,
        content: typeof m.content === "string" ? m.content : "",
      }))
      .filter((m) => m.content.trim().length > 0)
      .filter((m) => !m.content.startsWith(ARTIFACT_MESSAGE_PREFIX));

    return filtered.slice(Math.max(0, filtered.length - 3));
  }, [previewMessages]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="share-chat-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: [0.19, 1, 0.22, 1] }}
          className={cn(
            "fixed inset-0 z-[100] flex items-start justify-center p-4 sm:p-6",
            isDark ? "bg-black/60" : "bg-black/20",
            "backdrop-blur-sm"
          )}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.19, 1, 0.22, 1] }}
            className="mt-[10vh] w-full max-w-[520px] rounded-2xl border border-default shadow-2xl overflow-hidden bg-elevated text-primary shadow-black/25"
            role="dialog"
            aria-modal="true"
            aria-label="Share chat"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Header */}
            <div className="border-b px-5 py-4 border-default">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={cn(
                    "shrink-0 w-8 h-8 rounded-lg flex items-center justify-center",
                    isDark ? "bg-emerald-500/15" : "bg-emerald-50"
                  )}>
                    <Share2 className={cn("w-4 h-4", isDark ? "text-emerald-400" : "text-emerald-600")} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[16px] font-semibold tracking-tight truncate">{title}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="p-2 rounded-full transition-colors text-muted hover:text-primary hover:bg-tertiary"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="px-5 pt-4">
              {/* Privacy notice */}
              <div className="flex items-start gap-3 rounded-xl border border-default bg-secondary p-3">
                <Info className="mt-0.5 w-4 h-4 shrink-0 text-muted" />
                <div className="text-[13px] leading-snug text-secondary">
                  <div className="font-medium">Review before sharing</div>
                  <div className="mt-0.5 text-muted">
                    Anyone with the link can view this conversation. Check for personal or sensitive information first.
                  </div>
                </div>
              </div>

              {error ? (
                <div className={cn("mt-3 rounded-lg px-3 py-2 text-[12px]", isDark ? "bg-red-500/10 text-red-300 border border-red-500/20" : "bg-red-50 text-red-600 border border-red-200/60")}>
                  {error}
                </div>
              ) : null}

              {/* Share URL field */}
              <div className="mt-3">
                <div className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors",
                  shareUrl
                    ? isDark ? "border-emerald-500/20 bg-emerald-500/5" : "border-emerald-200/60 bg-emerald-50/50"
                    : "border-default bg-secondary"
                )}>
                  <Globe className={cn("w-4 h-4 shrink-0", shareUrl ? isDark ? "text-emerald-400" : "text-emerald-500" : "text-muted")} />
                  <input
                    ref={urlInputRef}
                    type="text"
                    readOnly
                    value={shareUrl ?? (isCreating ? "Generating link…" : "Preparing share…")}
                    className={cn(
                      "flex-1 min-w-0 bg-transparent text-[13px] outline-none select-all",
                      shareUrl ? "text-primary" : "text-muted"
                    )}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={copyLink}
                    disabled={isCreating}
                    className={cn(
                      "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all",
                      copied
                        ? isDark ? "bg-emerald-500/20 text-emerald-300" : "bg-emerald-100 text-emerald-700"
                        : isDark ? "bg-white/10 hover:bg-white/15 text-zinc-200" : "bg-white hover:bg-zinc-50 text-zinc-700 shadow-sm border border-zinc-200/60",
                      isCreating ? "opacity-50 cursor-not-allowed" : ""
                    )}
                  >
                    {isCreating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : copied ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <LinkIcon className="w-3.5 h-3.5" />
                    )}
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Preview */}
              <div className="mt-3 rounded-xl border border-default bg-secondary p-3">
                <div className="text-[12px] mb-2 text-muted">
                  Preview ({preview.length} message{preview.length !== 1 ? "s" : ""})
                </div>
                <div className="max-h-[160px] overflow-y-auto space-y-2 scrollbar-hide">
                  {preview.length === 0 ? (
                    <div className="text-[13px] text-muted">
                      No messages to preview yet.
                    </div>
                  ) : (
                    preview.map((m, idx) => (
                      <div key={m.id ?? `${m.role}:${idx}`} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                        <div
                          className={cn(
                            "max-w-[85%] rounded-[20px] px-4 pt-3.5 pb-3 text-[13px] leading-relaxed",
                            m.role === "user"
                              ? "bg-tertiary text-primary"
                              : "bg-white/0 text-secondary"
                          )}
                        >
                          <div className="whitespace-pre-wrap break-words line-clamp-3">{m.content}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Social share buttons */}
            <div className="px-5 pb-5 pt-4">
              <div className="text-[12px] text-muted mb-3">Share to</div>
              <div className="flex items-center gap-3">
                {/* X / Twitter */}
                <button
                  type="button"
                  disabled={!shareUrl}
                  onClick={() => shareTo("x")}
                  className={cn(
                    "flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl border text-[13px] font-medium transition-colors",
                    "border-default bg-secondary",
                    !shareUrl ? "opacity-50 cursor-not-allowed" : "hover:bg-tertiary"
                  )}
                  title="Share on X"
                >
                  <XTwitterIcon className="w-4 h-4" />
                  <span>Post</span>
                </button>

                {/* LinkedIn */}
                <button
                  type="button"
                  disabled={!shareUrl}
                  onClick={() => shareTo("linkedin")}
                  className={cn(
                    "flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl border text-[13px] font-medium transition-colors",
                    "border-default bg-secondary",
                    !shareUrl ? "opacity-50 cursor-not-allowed" : "hover:bg-tertiary"
                  )}
                  title="Share on LinkedIn"
                >
                  <Linkedin className="w-4 h-4" />
                  <span>Share</span>
                </button>

                {/* Reddit */}
                <button
                  type="button"
                  disabled={!shareUrl}
                  onClick={() => shareTo("reddit")}
                  className={cn(
                    "flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl border text-[13px] font-medium transition-colors",
                    "border-default bg-secondary",
                    !shareUrl ? "opacity-50 cursor-not-allowed" : "hover:bg-tertiary"
                  )}
                  title="Share on Reddit"
                >
                  <MessageCircle className="w-4 h-4" />
                  <span>Post</span>
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
