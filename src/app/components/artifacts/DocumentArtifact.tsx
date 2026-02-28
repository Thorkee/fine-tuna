"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import Placeholder from "@tiptap/extension-placeholder";
import DOMPurify from "dompurify";
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Code,
  Undo2,
  Redo2,
  Table2,
  Upload,
  Download,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from "lucide-react";

import { useArtifactChatId } from "@/lib/artifact-scope";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import { looksLikeHtml, normalizeDocumentHtml } from "@/lib/markdown";

type DocumentArtifactData = {
  kind: "document";
  title?: string;
  html: string;
  updatedAt?: string;
  version?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractHtml(data: unknown): string | null {
  if (!data) return null;
  const raw =
    typeof data === "string"
      ? data
      : isRecord(data)
        ? data.html ?? data.content ?? data.body ?? data.markdown
        : null;
  if (typeof raw !== "string") return null;
  const normalized = normalizeDocumentHtml(raw);
  if (!normalized) return null;
  if (looksLikeHtml(raw)) return normalized;
  return DOMPurify.sanitize(normalized, { USE_PROFILES: { html: true } });
}

function extractTitle(data: unknown): string | null {
  if (!data || !isRecord(data)) return null;
  const title = data.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

const DEFAULT_HTML = "<h1>Untitled Report</h1><p>Start writing here…</p>";

export default function DocumentArtifact(props: {
  artifactId?: string;
  dataOverride?: unknown;
  chatId?: string | null;
}) {
  const artifactId = props.artifactId ?? "document";
  const dataOverride = props.dataOverride;
  const chatIdProp = props.chatId;

  const { artifacts, addArtifact } = useProjectArtifacts();
  const contextChatId = useArtifactChatId();
  const params = useParams();
  const routeChatIdRaw = (params as { chatId?: string | string[] })?.chatId;
  const routeChatId = Array.isArray(routeChatIdRaw) ? routeChatIdRaw[0] : routeChatIdRaw;
  const chatId = chatIdProp ?? contextChatId ?? (typeof routeChatId === "string" ? routeChatId : "");

  const resolvedData = useMemo(() => {
    if (dataOverride !== undefined) return dataOverride;
    return artifacts.find((a) => a.id === artifactId)?.data;
  }, [artifacts, artifactId, dataOverride]);

  const [title, setTitle] = useState(() => extractTitle(resolvedData) ?? "Document");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const isReadOnly = dataOverride !== undefined;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedHtmlRef = useRef<string | null>(null);
  const applyingRef = useRef(false);

  const initialHtml = useMemo(() => {
    const html = extractHtml(resolvedData);
    return html && html.trim() ? html : DEFAULT_HTML;
  }, [resolvedData]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: true,
        autolink: true,
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: "Start typing…" }),
    ],
    content: initialHtml,
    editable: !isReadOnly,
    onUpdate: ({ editor }) => {
      if (applyingRef.current) return;
      const html = editor.getHTML();
      scheduleSave(html, title);
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!isReadOnly);
  }, [editor, isReadOnly]);

  useEffect(() => {
    const nextTitle = extractTitle(resolvedData);
    if (nextTitle) setTitle(nextTitle);
  }, [resolvedData]);

  useEffect(() => {
    if (!editor) return;
    const nextHtml = extractHtml(resolvedData);
    if (!nextHtml) return;
    if (nextHtml === lastSavedHtmlRef.current) return;
    applyingRef.current = true;
    editor.commands.setContent(nextHtml, { emitUpdate: false });
    applyingRef.current = false;
  }, [editor, resolvedData]);

  const scheduleSave = (html: string, nextTitle?: string) => {
    if (isReadOnly) return;
    const clean = html.trim();
    if (!clean) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void persistDocument(clean, nextTitle ?? title);
    }, 650);
  };

  const persistDocument = async (html: string, nextTitle: string) => {
    if (!chatId) return;
    if (html === lastSavedHtmlRef.current && nextTitle === title) return;

    const payload: DocumentArtifactData = {
      kind: "document",
      title: nextTitle,
      html,
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    setStatus("saving");
    setLastError(null);
    try {
      addArtifact({ id: artifactId, type: "document", data: payload });
      const res = await fetch("/api/chat/artifacts/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          artifact: { id: artifactId, type: "document", data: payload },
        }),
      });
      if (!res.ok) {
        throw new Error(`Save failed (${res.status})`);
      }
      lastSavedHtmlRef.current = html;
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1200);
    } catch (error) {
      setStatus("error");
      setLastError(error instanceof Error ? error.message : "Save failed");
    }
  };

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (editor) scheduleSave(editor.getHTML(), value);
  };

  const handleImportDocx = async (file: File) => {
    if (!editor) return;
    setIsImporting(true);
    setLastError(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const mammoth = await import("mammoth/mammoth.browser");
      const result = await mammoth.convertToHtml({ arrayBuffer });
      const sanitized = DOMPurify.sanitize(result.value || "", {
        USE_PROFILES: { html: true },
      });
      applyingRef.current = true;
      editor.commands.setContent(sanitized || DEFAULT_HTML, { emitUpdate: false });
      applyingRef.current = false;
      const nextTitle = file.name.replace(/\.docx$/i, "") || title;
      setTitle(nextTitle);
      scheduleSave(editor.getHTML(), nextTitle);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Import failed");
      setStatus("error");
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleExport = async () => {
    if (!chatId) return;
    setIsExporting(true);
    setLastError(null);
    try {
      const res = await fetch("/api/chat/artifacts/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          artifactId,
          type: "document",
        }),
      });
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`);
      }
      const payload = (await res.json()) as { url?: string };
      if (!payload.url) throw new Error("Export failed");
      window.open(payload.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Export failed");
      setStatus("error");
    } finally {
      setIsExporting(false);
    }
  };

  const actionButton = (label: string, onClick: () => void, disabled?: boolean, icon?: React.ReactNode) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
        disabled
          ? "bg-zinc-100 dark:bg-white/5 text-zinc-400 cursor-not-allowed"
          : "bg-zinc-900 text-white dark:bg-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  const toolbarButton = (label: string, onClick: () => void, active?: boolean, icon?: React.ReactNode) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!editor || isReadOnly}
      className={`p-1.5 rounded-md transition-colors text-xs ${
        active
          ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
          : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/10"
      } ${isReadOnly ? "opacity-50 cursor-not-allowed" : ""}`}
      title={label}
    >
      {icon}
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-primary text-primary">
      <div className="shrink-0 border-b border-zinc-200/70 dark:border-white/10 px-3 sm:px-4 py-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <input
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              disabled={isReadOnly}
              className="text-[15px] font-semibold bg-transparent outline-none border-b border-transparent focus:border-zinc-400/70 dark:focus:border-white/30 transition-colors"
              placeholder="Document title"
            />
            {status === "saving" ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Saving
              </span>
            ) : status === "saved" ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Saved
              </span>
            ) : status === "error" ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-red-500">
                <AlertTriangle className="w-3.5 h-3.5" />
                {lastError ?? "Save failed"}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportDocx(file);
              }}
            />
            {actionButton("Import DOCX", () => fileInputRef.current?.click(), isReadOnly || isImporting, <Upload className="w-4 h-4" />)}
            {actionButton("Export DOCX", handleExport, isExporting, <Download className="w-4 h-4" />)}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {toolbarButton("H1", () => editor?.chain().focus().toggleHeading({ level: 1 }).run(), editor?.isActive("heading", { level: 1 }), <Heading1 className="w-4 h-4" />)}
          {toolbarButton("H2", () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), editor?.isActive("heading", { level: 2 }), <Heading2 className="w-4 h-4" />)}
          {toolbarButton("Bold", () => editor?.chain().focus().toggleBold().run(), editor?.isActive("bold"), <Bold className="w-4 h-4" />)}
          {toolbarButton("Italic", () => editor?.chain().focus().toggleItalic().run(), editor?.isActive("italic"), <Italic className="w-4 h-4" />)}
          {toolbarButton("Bullet list", () => editor?.chain().focus().toggleBulletList().run(), editor?.isActive("bulletList"), <List className="w-4 h-4" />)}
          {toolbarButton("Ordered list", () => editor?.chain().focus().toggleOrderedList().run(), editor?.isActive("orderedList"), <ListOrdered className="w-4 h-4" />)}
          {toolbarButton("Quote", () => editor?.chain().focus().toggleBlockquote().run(), editor?.isActive("blockquote"), <Quote className="w-4 h-4" />)}
          {toolbarButton("Code", () => editor?.chain().focus().toggleCodeBlock().run(), editor?.isActive("codeBlock"), <Code className="w-4 h-4" />)}
          {toolbarButton("Insert table", () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), false, <Table2 className="w-4 h-4" />)}
          {toolbarButton("Undo", () => editor?.chain().focus().undo().run(), false, <Undo2 className="w-4 h-4" />)}
          {toolbarButton("Redo", () => editor?.chain().focus().redo().run(), false, <Redo2 className="w-4 h-4" />)}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="prose prose-sm max-w-none dark:prose-invert p-4">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
