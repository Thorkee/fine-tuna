"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Copy,
  Download,
  FileText,
  Folder,
  Paperclip,
  Pencil,
  RefreshCcw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

import { useArtifactChatId } from "@/lib/artifact-scope";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { normalizeSandboxState } from "@/lib/sandbox/sandbox-state";

type StorageBucket = "uploads" | "artifacts";

type ChatFilesResponse = {
  uploads?: Array<{
    bucket: "uploads";
    storagePath: string;
    name: string;
    size?: number;
    lastModified?: string;
  }>;
  outputs?: Array<{
    bucket: "artifacts";
    storagePath: string;
    name: string;
    size?: number;
    lastModified?: string;
  }>;
};

type RunnerListResponse = {
  session_id?: string;
  path?: string;
  items?: Array<{ name?: string; path?: string; type?: string; size?: number }>;
};

type FileSource = "uploads" | "outputs" | "sandbox";

const SANDBOX_ROOTS = ["/code", "/pipelines"] as const;
type SandboxRoot = (typeof SANDBOX_ROOTS)[number];
const MAX_CSV_ROWS = 120;
const MAX_CSV_COLUMNS = 12;

SyntaxHighlighter.registerLanguage("python", python);

type StorageFileEntry = {
  source: "uploads" | "outputs";
  bucket: StorageBucket;
  storagePath: string;
  name: string;
  size?: number;
  lastModified?: string;
};

type SandboxFileEntry = {
  source: "sandbox";
  sessionId: string;
  path: string;
  name: string;
  type?: string;
  size?: number;
};

type FileEntry = StorageFileEntry | SandboxFileEntry;

type ListRow =
  | {
      kind: "storage-folder";
      source: "uploads" | "outputs";
      name: string;
      folder: string; // relative, always ends with "/"
      count: number;
    }
  | {
      kind: "sandbox-dir";
      name: string;
      path: string;
    }
  | {
      kind: "file";
      entry: FileEntry;
      displayPath: string;
    };

export type AttachFileRef = {
  id: string;
  name: string;
  size: number;
  mimeType?: string;
  storagePath: string;
};

type CsvPreview = {
  rows: string[][];
  columnCount: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

function parseCsvPreview(text: string, maxRows = MAX_CSV_ROWS, maxCols = MAX_CSV_COLUMNS): CsvPreview {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let truncatedRows = false;
  let truncatedColumns = false;
  let rowColumnCount = 0;

  const pushField = () => {
    if (rowColumnCount < maxCols) {
      row.push(field);
    } else {
      truncatedColumns = true;
    }
    rowColumnCount += 1;
    field = "";
  };

  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    rowColumnCount = 0;
    if (rows.length >= maxRows) truncatedRows = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "," || ch === "\n" || ch === "\r")) {
      if (ch === ",") {
        pushField();
        continue;
      }
      pushRow();
      if (truncatedRows) break;
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      continue;
    }
    field += ch;
  }

  if (!truncatedRows && (field.length > 0 || row.length > 0 || rowColumnCount > 0)) {
    pushRow();
  }

  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell.trim() === "")) {
    rows.pop();
  }

  const columnCount = rows.reduce((max, next) => Math.max(max, next.length), 0);

  return { rows, columnCount, truncatedRows, truncatedColumns };
}

export default function FilesDrawer(props: {
  open: boolean;
  onClose: () => void;
  onAttach?: (file: AttachFileRef) => void;
  isDark?: boolean;
}) {
  const { open, onClose, onAttach, isDark = false } = props;
  const params = useParams();
  const routeChatId = useMemo(() => {
    const raw = (params as { chatId?: string | string[] })?.chatId;
    if (Array.isArray(raw)) return raw[0] ?? "";
    return typeof raw === "string" ? raw : "";
  }, [params]);
  const contextChatId = useArtifactChatId();
  const chatId = contextChatId ?? routeChatId;

  const { artifacts } = useProjectArtifacts();
  const sandboxSessionId = useMemo(() => {
    const a = artifacts.find((x) => x.id === "sandbox");
    const state = normalizeSandboxState(a?.data);
    return state?.sessionId ?? "";
  }, [artifacts]);

  const [activeSource, setActiveSource] = useState<FileSource>("uploads");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uploads, setUploads] = useState<StorageFileEntry[]>([]);
  const [outputs, setOutputs] = useState<StorageFileEntry[]>([]);

  const [sandboxRoot, setSandboxRoot] = useState<SandboxRoot>("/code");
  const [sandboxPath, setSandboxPath] = useState("/code");
  const [sandboxItems, setSandboxItems] = useState<SandboxFileEntry[]>([]);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [uploadsFolder, setUploadsFolder] = useState("");
  const [outputsFolder, setOutputsFolder] = useState("");

  const [selected, setSelected] = useState<FileEntry | null>(null);
  const isMdUp = useMediaQuery("(min-width: 768px)");
  const [mobileView, setMobileView] = useState<"list" | "preview">("list");
  const [previewMode, setPreviewMode] = useState<"view" | "edit">("view");
  const [previewText, setPreviewText] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const objectUrlRef = useRef<string>("");

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameFolder, setRenameFolder] = useState("");
  const [renameName, setRenameName] = useState("");
  const [actionBusy, setActionBusy] = useState<string>("");

  const clearPreview = useCallback(() => {
    setPreviewMode("view");
    setPreviewText("");
    setPreviewUrl("");
    setPreviewError(null);
    setPreviewLoading(false);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = "";
    }
  }, []);

  const canWriteSandboxPath = useCallback((p: string) => p === "/code" || p.startsWith("/code/"), []);

  const isTextLikeName = (name: string) =>
    /\.(txt|md|json|csv|ts|tsx|js|jsx|py|java|go|rs|html|css|yaml|yml|xml|log)$/i.test(name);
  const isImageName = (name: string) => /\.(png|jpg|jpeg|gif|webp)$/i.test(name);
  const isPythonName = (name: string) => /\.py$/i.test(name);
  const isCsvName = (name: string) => /\.csv$/i.test(name);

  const formatBytes = (bytes?: number) => {
    if (!bytes || !Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(1)} GB`;
  };

  const storageRelativePath = useCallback(
    (entry: StorageFileEntry): string => {
      const key = entry.storagePath;
      if (entry.bucket === "uploads") {
        const parts = key.split("/").filter(Boolean);
        // uploads: {userId}/{chatId}/... → show relative portion
        return parts.length >= 3 ? parts.slice(2).join("/") : key;
      }
      // artifacts outputs: exports/{chatId}/... or runner-outputs/{chatId}/...
      if (chatId && key.startsWith(`exports/${chatId}/`)) return key.slice(`exports/${chatId}/`.length);
      if (chatId && key.startsWith(`runner-outputs/${chatId}/`))
        return key.slice(`runner-outputs/${chatId}/`.length);
      return key;
    },
    [chatId]
  );

  function normalizeRelFolder(folder: string): string {
    const trimmed = String(folder || "").trim().replace(/^\/+/, "");
    if (!trimmed) return "";
    const parts = trimmed.split("/").filter(Boolean);
    if (parts.includes("..")) return "";
    const joined = parts.join("/");
    return joined.endsWith("/") ? joined : `${joined}/`;
  }

  function parentRelFolder(folder: string): string {
    const norm = normalizeRelFolder(folder);
    if (!norm) return "";
    const parts = norm.split("/").filter(Boolean);
    if (parts.length <= 1) return "";
    return `${parts.slice(0, -1).join("/")}/`;
  }

  const fetchChatFiles = useCallback(async () => {
    if (!chatId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/chat/${encodeURIComponent(chatId)}/files`);
      const data = (await resp.json().catch(() => null)) as ChatFilesResponse | null;
      if (!resp.ok) {
        const message = typeof (data as { error?: unknown } | null)?.error === "string"
          ? String((data as { error: string }).error)
          : `Failed to load files (${resp.status})`;
        throw new Error(message);
      }
      const uploadsNext: StorageFileEntry[] = (Array.isArray(data?.uploads) ? data!.uploads : []).map((f) => ({
        source: "uploads",
        bucket: "uploads",
        storagePath: f.storagePath,
        name: f.name,
        size: f.size,
        lastModified: f.lastModified,
      }));
      const outputsNext: StorageFileEntry[] = (Array.isArray(data?.outputs) ? data!.outputs : []).map((f) => ({
        source: "outputs",
        bucket: "artifacts",
        storagePath: f.storagePath,
        name: f.name,
        size: f.size,
        lastModified: f.lastModified,
      }));
      setUploads(uploadsNext);
      setOutputs(outputsNext);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load files";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  const fetchSandboxFiles = useCallback(async () => {
    if (!open || !chatId || !sandboxSessionId) return;
    setSandboxLoading(true);
    try {
      const resp = await fetch(
        `/api/runner/sessions/${encodeURIComponent(sandboxSessionId)}/files?chatId=${encodeURIComponent(
          chatId
        )}&path=${encodeURIComponent(sandboxPath)}`
      );
      const data = (await resp.json().catch(() => null)) as RunnerListResponse | null;
      if (!resp.ok) {
        const message = typeof (data as { error?: unknown } | null)?.error === "string"
          ? String((data as { error: string }).error)
          : `Failed to list sandbox files (${resp.status})`;
        throw new Error(message);
      }
      const items = Array.isArray(data?.items) ? data!.items : [];
      const next: SandboxFileEntry[] = items
        .filter((it) => it && typeof it === "object" && typeof it.path === "string")
        .map((it) => ({
          source: "sandbox",
          sessionId: sandboxSessionId,
          path: String(it.path),
          name: typeof it.name === "string" && it.name.trim() ? it.name : String(it.path).split("/").pop() || "file",
          type: typeof it.type === "string" ? it.type : undefined,
          size: typeof it.size === "number" ? it.size : undefined,
        }));
      setSandboxItems(next);
    } catch {
      // Ignore sandbox list errors; user can retry.
      setSandboxItems([]);
    } finally {
      setSandboxLoading(false);
    }
  }, [chatId, open, sandboxPath, sandboxSessionId]);

  useEffect(() => {
    if (!open) return;
    void fetchChatFiles();
  }, [open, fetchChatFiles]);

  useEffect(() => {
    if (!open) return;
    if (activeSource !== "sandbox") return;
    void fetchSandboxFiles();
  }, [open, activeSource, fetchSandboxFiles]);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setRenameOpen(false);
    clearPreview();
  }, [activeSource, clearPreview, open]);

  useEffect(() => {
    if (isMdUp || !open || !selected) {
      setMobileView("list");
    }
  }, [isMdUp, open, selected]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = "";
      }
    };
  }, []);

  const isMobileList = !isMdUp && mobileView === "list";
  const isMobilePreview = !isMdUp && mobileView === "preview";

  const listRows: ListRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (activeSource === "sandbox") {
      const base = sandboxItems;
      const filtered = q
        ? base.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
        : base;

      const isDir = (f: SandboxFileEntry) =>
        typeof f.type === "string" && f.type.toLowerCase().includes("dir");
      const dirs = filtered.filter(isDir).sort((a, b) => a.name.localeCompare(b.name));
      const files = filtered.filter((f) => !isDir(f)).sort((a, b) => a.name.localeCompare(b.name));

      return [
        ...dirs.map(
          (d) =>
            ({
              kind: "sandbox-dir",
              name: d.name,
              path: d.path,
            }) satisfies ListRow
        ),
        ...files.map(
          (f) =>
            ({
              kind: "file",
              entry: f,
              displayPath: f.path,
            }) satisfies ListRow
        ),
      ];
    }

    const base = activeSource === "uploads" ? uploads : outputs;
    const currentFolder = activeSource === "uploads" ? uploadsFolder : outputsFolder;

    const fileMatches: Array<{ entry: StorageFileEntry; rel: string }> = [];
    const folderMap = new Map<string, { name: string; folder: string; count: number }>();

    for (const entry of base) {
      const rel = storageRelativePath(entry);
      const relLower = rel.toLowerCase();
      if (q) {
        if (entry.name.toLowerCase().includes(q) || relLower.includes(q)) {
          fileMatches.push({ entry, rel });
        }
        continue;
      }

      if (currentFolder && !rel.startsWith(currentFolder)) continue;
      const rest = currentFolder ? rel.slice(currentFolder.length) : rel;
      if (!rest) continue;

      const slashIdx = rest.indexOf("/");
      if (slashIdx !== -1) {
        const folderName = rest.slice(0, slashIdx).trim();
        if (!folderName) continue;
        const folder = `${currentFolder}${folderName}/`;
        const prev = folderMap.get(folder);
        if (prev) prev.count += 1;
        else folderMap.set(folder, { name: folderName, folder, count: 1 });
        continue;
      }

      fileMatches.push({ entry, rel });
    }

    const folders: ListRow[] =
      q.length > 0
        ? []
        : Array.from(folderMap.values())
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(
              (f) =>
                ({
                  kind: "storage-folder",
                  source: activeSource,
                  name: f.name,
                  folder: f.folder,
                  count: f.count,
                }) satisfies ListRow
            );

    const files: ListRow[] = fileMatches
      .sort((a, b) => a.rel.localeCompare(b.rel))
      .map(
        ({ entry, rel }) =>
          ({
            kind: "file",
            entry,
            displayPath: rel,
          }) satisfies ListRow
      );

    return [...folders, ...files];
  }, [activeSource, outputs, outputsFolder, query, sandboxItems, storageRelativePath, uploads, uploadsFolder]);

  const selectedTitle = selected ? selected.name : "No file selected";

  const getSignedUrl = useCallback(
    async (bucket: StorageBucket, storagePath: string): Promise<string> => {
      const resp = await fetch("/api/storage/signed-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, bucket, storagePath }),
      });
      const data = (await resp.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!resp.ok || !data?.url) {
        throw new Error(data?.error || `Signed URL failed (${resp.status})`);
      }
      return data.url;
    },
    [chatId]
  );

  const loadPreview = useCallback(
    async (entry: FileEntry | null) => {
      clearPreview();
      if (!entry || !chatId) return;

      const name = entry.name;
      const shouldText = isTextLikeName(name);
      const shouldImage = isImageName(name);
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        if (entry.source === "sandbox") {
          const url = `/api/runner/sessions/${encodeURIComponent(entry.sessionId)}/files/content?chatId=${encodeURIComponent(
            chatId
          )}&path=${encodeURIComponent(entry.path)}`;
          const resp = await fetch(url);
          if (!resp.ok) {
            const data = (await resp.json().catch(() => null)) as { error?: string } | null;
            throw new Error(data?.error || `Preview failed (${resp.status})`);
          }
          if (shouldImage) {
            const blob = await resp.blob();
            const objectUrl = URL.createObjectURL(blob);
            objectUrlRef.current = objectUrl;
            setPreviewUrl(objectUrl);
            return;
          }
          if (shouldText) {
            const text = await resp.text();
            setPreviewText(text.slice(0, 40_000));
            return;
          }
          return;
        }

        const signedUrl = await getSignedUrl(entry.bucket, entry.storagePath);
        if (shouldImage) {
          setPreviewUrl(signedUrl);
          return;
        }
        if (shouldText) {
          if (typeof entry.size === "number" && entry.size > 1_500_000) {
            setPreviewError("File too large to preview. Use Download.");
            return;
          }
          const resp = await fetch(signedUrl);
          if (!resp.ok) throw new Error(`Preview fetch failed (${resp.status})`);
          const text = await resp.text();
          setPreviewText(text.slice(0, 40_000));
          return;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Preview failed";
        setPreviewError(message);
      } finally {
        setPreviewLoading(false);
      }
    },
    [chatId, clearPreview, getSignedUrl]
  );

  useEffect(() => {
    if (!open) return;
    void loadPreview(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.source === "sandbox" ? (selected as SandboxFileEntry | null)?.path : (selected as StorageFileEntry | null)?.storagePath, open]);

  const downloadSelected = useCallback(async () => {
    if (!selected || !chatId) return;
    try {
      if (selected.source === "sandbox") {
        const url = `/api/runner/sessions/${encodeURIComponent(selected.sessionId)}/files/content?chatId=${encodeURIComponent(
          chatId
        )}&path=${encodeURIComponent(selected.path)}`;
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      const url = await getSignedUrl(selected.bucket, selected.storagePath);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Download failed";
      setPreviewError(message);
    }
  }, [chatId, getSignedUrl, selected]);

  const copyReferenceSelected = useCallback(async () => {
    if (!selected) return;
    const value = selected.source === "sandbox" ? selected.path : selected.storagePath;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback: prompt allows manual copy.
      window.prompt("Copy reference:", value);
    }
  }, [selected]);

  const attachSelected = useCallback(async () => {
    if (!selected || !chatId || !onAttach) return;
    setActionBusy("attach");
    try {
      const id = crypto.randomUUID();
      if (selected.source === "uploads") {
        onAttach({
          id,
          name: selected.name,
          size: selected.size ?? 0,
          storagePath: selected.storagePath,
        });
        return;
      }
      if (selected.source === "outputs") {
        const resp = await fetch("/api/storage/copy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            fromBucket: "artifacts",
            fromStoragePath: selected.storagePath,
            toBucket: "uploads",
            fileName: selected.name,
          }),
        });
        const data = (await resp.json().catch(() => null)) as
          | { ok?: boolean; to?: { bucket?: string; storagePath?: string }; error?: string }
          | null;
        if (!resp.ok || !data?.to?.storagePath) {
          throw new Error(data?.error || `Copy failed (${resp.status})`);
        }
        onAttach({
          id,
          name: selected.name,
          size: selected.size ?? 0,
          storagePath: data.to.storagePath,
        });
        return;
      }
      // sandbox → persist to uploads then attach
      if (selected.source !== "sandbox") return;
      const resp = await fetch(
        `/api/runner/sessions/${encodeURIComponent(selected.sessionId)}/persist?chatId=${encodeURIComponent(chatId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sandboxPath: selected.path, targetBucket: "uploads", fileName: selected.name }),
        }
      );
      const data = (await resp.json().catch(() => null)) as { storagePath?: string; error?: string } | null;
      if (!resp.ok || !data?.storagePath) {
        throw new Error(data?.error || `Persist failed (${resp.status})`);
      }
      onAttach({
        id,
        name: selected.name,
        size: selected.size ?? 0,
        storagePath: data.storagePath,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Attach failed";
      setPreviewError(message);
    } finally {
      setActionBusy("");
    }
  }, [chatId, onAttach, selected]);

  const openRename = useCallback(() => {
    if (!selected || selected.source === "sandbox") return;
    setRenameOpen(true);
    setRenameFolder("");
    setRenameName(selected.name);
  }, [selected]);

  const performMove = useCallback(async () => {
    if (!selected || selected.source === "sandbox") return;
    if (!chatId) return;
    const folder = renameFolder.trim().replace(/^\/+/, "");
    const name = renameName.trim();
    if (!name) return;

    const from = selected.storagePath;
    const parts = from.split("/").filter(Boolean);
    const basePrefix =
      selected.bucket === "uploads"
        ? parts.length >= 2
          ? `${parts[0]}/${parts[1]}/`
          : ""
        : from.startsWith(`exports/${chatId}/`)
          ? `exports/${chatId}/`
          : `runner-outputs/${chatId}/`;
    if (!basePrefix) {
      setPreviewError("Unable to compute destination prefix.");
      return;
    }

    const folderNorm = folder ? (folder.endsWith("/") ? folder : `${folder}/`) : "";
    const to = `${basePrefix}${folderNorm}${name}`;

    setActionBusy("move");
    try {
      const resp = await fetch("/api/storage/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          bucket: selected.bucket,
          fromStoragePath: from,
          toStoragePath: to,
        }),
      });
      const data = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!resp.ok) throw new Error(data?.error || `Move failed (${resp.status})`);
      setRenameOpen(false);
      await fetchChatFiles();
      setSelected({ ...selected, storagePath: to, name } as StorageFileEntry);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Move failed";
      setPreviewError(message);
    } finally {
      setActionBusy("");
    }
  }, [chatId, fetchChatFiles, renameFolder, renameName, selected]);

  const deleteSelected = useCallback(async () => {
    if (!selected || selected.source === "sandbox") return;
    if (!chatId) return;
    const ok = window.confirm(`Delete ${selected.name}? This cannot be undone.`);
    if (!ok) return;
    setActionBusy("delete");
    try {
      const resp = await fetch("/api/storage/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          bucket: selected.bucket,
          storagePath: selected.storagePath,
        }),
      });
      const data = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!resp.ok) throw new Error(data?.error || `Delete failed (${resp.status})`);
      await fetchChatFiles();
      setSelected(null);
      clearPreview();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Delete failed";
      setPreviewError(message);
    } finally {
      setActionBusy("");
    }
  }, [chatId, clearPreview, fetchChatFiles, selected]);

  const startEdit = useCallback(async () => {
    if (!selected || !chatId) return;
    if (selected.source === "sandbox" && !canWriteSandboxPath((selected as SandboxFileEntry).path)) {
      setPreviewError("Editing is limited to /code. Copy the file into /code to edit.");
      return;
    }
    if (!isTextLikeName(selected.name)) {
      setPreviewError("Only text-like files can be edited.");
      return;
    }
    setPreviewMode("edit");
    if (!previewText) {
      await loadPreview(selected);
    }
  }, [canWriteSandboxPath, chatId, loadPreview, previewText, selected]);

  const saveEdit = useCallback(async () => {
    if (!selected || !chatId) return;
    setActionBusy("save");
    try {
      if (selected.source === "sandbox") {
        if (!canWriteSandboxPath((selected as SandboxFileEntry).path)) {
          throw new Error("Editing is limited to /code. Copy the file into /code to edit.");
        }
        const resp = await fetch(
          `/api/runner/sessions/${encodeURIComponent(selected.sessionId)}/files?chatId=${encodeURIComponent(chatId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              files: [{ path: selected.path, content_text: previewText }],
            }),
          }
        );
        const data = (await resp.json().catch(() => null)) as { error?: string } | null;
        if (!resp.ok) throw new Error(data?.error || `Save failed (${resp.status})`);
        setPreviewMode("view");
        await fetchSandboxFiles();
        return;
      }

      const resp = await fetch("/api/storage/update-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          bucket: selected.bucket,
          storagePath: selected.storagePath,
          contentText: previewText,
          contentType: "text/plain; charset=utf-8",
        }),
      });
      const data = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!resp.ok) throw new Error(data?.error || `Save failed (${resp.status})`);
      setPreviewMode("view");
      await fetchChatFiles();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Save failed";
      setPreviewError(message);
    } finally {
      setActionBusy("");
    }
  }, [canWriteSandboxPath, chatId, fetchChatFiles, fetchSandboxFiles, previewText, selected]);

  const copyToSandbox = useCallback(async () => {
    if (!selected || selected.source === "sandbox") return;
    if (!chatId || !sandboxSessionId) {
      setPreviewError("Start a sandbox session first.");
      return;
    }
    const destPath = window.prompt("Copy to sandbox path:", `/code/${selected.name}`) || "";
    if (!destPath.trim()) return;
    setActionBusy("copy_to_sandbox");
    try {
      const resp = await fetch(
        `/api/runner/sessions/${encodeURIComponent(sandboxSessionId)}/files/copy-from-storage?chatId=${encodeURIComponent(
          chatId
        )}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bucket: selected.bucket,
            storagePath: selected.storagePath,
            destPath,
          }),
        }
      );
      const data = (await resp.json().catch(() => null)) as { error?: string } | null;
      if (!resp.ok) throw new Error(data?.error || `Copy failed (${resp.status})`);
      setActiveSource("sandbox");
      setSandboxRoot("/code");
      setSandboxPath("/code");
      await fetchSandboxFiles();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Copy to sandbox failed";
      setPreviewError(message);
    } finally {
      setActionBusy("");
    }
  }, [chatId, fetchSandboxFiles, sandboxSessionId, selected]);

  const persistSandbox = useCallback(async () => {
    if (!selected || selected.source !== "sandbox") return;
    if (!chatId) return;
    setActionBusy("persist");
    try {
      const resp = await fetch(
        `/api/runner/sessions/${encodeURIComponent(selected.sessionId)}/persist?chatId=${encodeURIComponent(chatId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sandboxPath: selected.path, targetBucket: "artifacts", fileName: selected.name }),
        }
      );
      const data = (await resp.json().catch(() => null)) as { error?: string } | null;
      if (!resp.ok) throw new Error(data?.error || `Persist failed (${resp.status})`);
      await fetchChatFiles();
      setActiveSource("outputs");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Persist failed";
      setPreviewError(message);
    } finally {
      setActionBusy("");
    }
  }, [chatId, fetchChatFiles, selected]);

  const persistSandboxFolder = useCallback(async () => {
    if (!chatId || !sandboxSessionId) return;
    setActionBusy("persist_tree");
    try {
      const resp = await fetch(
        `/api/runner/sessions/${encodeURIComponent(sandboxSessionId)}/persist?chatId=${encodeURIComponent(chatId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sandboxPath,
            targetBucket: "artifacts",
            recursive: true,
          }),
        }
      );
      const data = (await resp.json().catch(() => null)) as { error?: string; count?: number } | null;
      if (!resp.ok) throw new Error(data?.error || `Persist folder failed (${resp.status})`);
      await fetchChatFiles();
      setActiveSource("outputs");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Persist folder failed";
      setPreviewError(message);
    } finally {
      setActionBusy("");
    }
  }, [chatId, fetchChatFiles, sandboxPath, sandboxSessionId]);

  const shellTone = isDark
    ? "border-white/10 bg-zinc-950/70 text-white"
    : "border-zinc-200/70 bg-white/95 text-zinc-900";
  const mutedTone = isDark ? "text-zinc-300" : "text-zinc-600";
  const dividerTone = isDark ? "border-white/10" : "border-zinc-200/70";

  const storageFolder =
    activeSource === "uploads" ? normalizeRelFolder(uploadsFolder) : normalizeRelFolder(outputsFolder);
  const storageFolderLabel = storageFolder ? `/${storageFolder.replace(/\/$/, "")}` : "/";
  const previewKind = selected
    ? isPythonName(selected.name)
      ? "python"
      : isCsvName(selected.name)
        ? "csv"
        : "text"
    : "none";
  const csvPreview = useMemo(() => {
    if (!previewText || previewKind !== "csv") return null;
    const parsed = parseCsvPreview(previewText);
    return parsed.rows.length > 0 ? parsed : null;
  }, [previewKind, previewText]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className={`fixed inset-0 z-[95] flex items-center justify-center p-4 ${
            isDark ? "bg-black/50" : "bg-black/20"
          } backdrop-blur-sm`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className={`relative w-[min(1100px,96vw)] h-[min(820px,90vh)] flex flex-col rounded-[28px] overflow-hidden border shadow-2xl backdrop-blur-xl ${shellTone}`}
            initial={{ y: 18, opacity: 0, scale: 0.985 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 18, opacity: 0, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.9 }}
          >
            {/* Top bar */}
            <div className={`h-14 flex items-center gap-3 px-4 border-b ${dividerTone}`}>
              <div className="font-semibold text-sm tracking-tight">Files</div>

              <div
                className={`hidden sm:flex items-center gap-1 p-1 rounded-full border ${
                  isDark ? "border-white/10 bg-white/5" : "border-zinc-200/70 bg-zinc-50"
                }`}
              >
                {(["uploads", "outputs", "sandbox"] as const).map((id) => {
                  const label = id === "uploads" ? "Uploads" : id === "outputs" ? "Outputs" : "Sandbox";
                  const count =
                    id === "uploads" ? uploads.length : id === "outputs" ? outputs.length : sandboxItems.length;
                  const active = activeSource === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveSource(id)}
                      className={`text-[11px] px-3 py-1.5 rounded-full transition-colors ${
                        active
                          ? isDark
                            ? "bg-white/10 text-white"
                            : "bg-white text-zinc-900 shadow-sm"
                          : isDark
                            ? "text-white/70 hover:bg-white/5"
                            : "text-zinc-600 hover:bg-white/70"
                      }`}
                    >
                      {label}
                      <span className="ml-1 opacity-60">{count}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex-1" />

              <div
                className={`hidden sm:flex items-center gap-2 rounded-full border px-3 py-2 ${
                  isDark ? "border-white/10 bg-white/5" : "border-zinc-200/70 bg-white"
                }`}
              >
                <Search className="w-4 h-4 opacity-50" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  className={`w-64 bg-transparent outline-none text-sm ${
                    isDark ? "placeholder:text-zinc-500" : "placeholder:text-zinc-400"
                  }`}
                />
              </div>

              <button
                type="button"
                onClick={() => (activeSource === "sandbox" ? fetchSandboxFiles() : fetchChatFiles())}
                className={`p-2 rounded-full border transition-colors ${
                  isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                }`}
                title="Refresh"
              >
                <RefreshCcw className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className={`p-2 rounded-full border transition-colors ${
                  isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                }`}
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Mobile source + search */}
            <div className={`px-4 pt-3 pb-2 space-y-2 sm:hidden border-b ${dividerTone}`}>
              <div
                className={`flex items-center gap-1 p-1 rounded-full border ${
                  isDark ? "border-white/10 bg-white/5" : "border-zinc-200/70 bg-zinc-50"
                }`}
              >
                {(["uploads", "outputs", "sandbox"] as const).map((id) => {
                  const label = id === "uploads" ? "Uploads" : id === "outputs" ? "Outputs" : "Sandbox";
                  const count =
                    id === "uploads" ? uploads.length : id === "outputs" ? outputs.length : sandboxItems.length;
                  const active = activeSource === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveSource(id)}
                      className={`flex-1 text-[11px] px-3 py-1.5 rounded-full transition-colors ${
                        active
                          ? isDark
                            ? "bg-white/10 text-white"
                            : "bg-white text-zinc-900 shadow-sm"
                          : isDark
                            ? "text-white/70 hover:bg-white/5"
                            : "text-zinc-600 hover:bg-white/70"
                      }`}
                    >
                      {label}
                      <span className="ml-1 opacity-60">{count}</span>
                    </button>
                  );
                })}
              </div>

              <div
                className={`flex items-center gap-2 rounded-full border px-3 py-2 ${
                  isDark ? "border-white/10 bg-white/5" : "border-zinc-200/70 bg-white"
                }`}
              >
                <Search className="w-4 h-4 opacity-50" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  className={`w-full bg-transparent outline-none text-sm ${
                    isDark ? "placeholder:text-zinc-500" : "placeholder:text-zinc-400"
                  }`}
                />
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[440px_1fr]">
              {/* List column */}
              <div
                className={`min-h-0 md:border-r ${dividerTone} ${
                  isMobilePreview ? "hidden" : "flex flex-col"
                }`}
              >
                <div className={`px-4 py-3 flex items-center gap-2 text-xs ${mutedTone} border-b ${dividerTone}`}>
                  <button
                    type="button"
                    onClick={() => {
                      if (activeSource === "sandbox") {
                        if (sandboxPath === sandboxRoot) return;
                        const parts = sandboxPath.split("/").filter(Boolean);
                        const rootParts = sandboxRoot.split("/").filter(Boolean);
                        const parent =
                          parts.length <= rootParts.length ? sandboxRoot : `/${parts.slice(0, -1).join("/")}`;
                        setSandboxPath(parent);
                        setSelected(null);
                        setRenameOpen(false);
                        clearPreview();
                        return;
                      }
                      if (activeSource === "uploads") setUploadsFolder((prev) => parentRelFolder(prev));
                      if (activeSource === "outputs") setOutputsFolder((prev) => parentRelFolder(prev));
                      setSelected(null);
                      setRenameOpen(false);
                      clearPreview();
                    }}
                    disabled={activeSource === "sandbox" ? sandboxPath === sandboxRoot : !storageFolder}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border transition-colors disabled:opacity-40 ${
                      isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                    }`}
                    title="Up"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Up
                  </button>

                  <span className="truncate">
                    {activeSource === "sandbox" ? `Path: ${sandboxPath}` : `Folder: ${storageFolderLabel}`}
                  </span>

                  {activeSource === "sandbox" ? (
                    <div className="hidden sm:flex items-center gap-1">
                      {SANDBOX_ROOTS.map((root) => {
                        const active = sandboxRoot === root;
                        return (
                          <button
                            key={root}
                            type="button"
                            onClick={() => {
                              setSandboxRoot(root);
                              setSandboxPath(root);
                              setSelected(null);
                              setRenameOpen(false);
                              clearPreview();
                            }}
                            className={`px-2 py-1 rounded-full border text-[11px] transition-colors ${
                              isDark
                                ? active
                                  ? "border-white/20 bg-white/10 text-white"
                                  : "border-white/10 text-white/70 hover:bg-white/5"
                                : active
                                  ? "border-zinc-300 bg-white text-zinc-900 shadow-sm"
                                  : "border-zinc-200/70 text-zinc-600 hover:bg-white/70"
                            }`}
                            title={`Browse ${root}`}
                          >
                            {root}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className="flex-1" />
                  {activeSource === "sandbox"
                    ? sandboxLoading
                      ? "Loading…"
                      : null
                    : loading
                      ? "Loading…"
                      : null}
                </div>

                {error ? <div className="px-4 py-2 text-xs text-red-500">{error}</div> : null}
                {!loading && activeSource === "sandbox" && !sandboxSessionId ? (
                  <div className={`px-4 py-3 text-xs ${mutedTone}`}>
                    No sandbox session yet. Ask the agent to start a sandbox (or run a command).
                  </div>
                ) : null}

                <div className="flex-1 min-h-0 overflow-y-auto p-2">
                  {listRows.length === 0 ? (
                    <div className={`p-4 text-xs ${mutedTone}`}>No files.</div>
                  ) : (
                    <div className="space-y-1">
                      {listRows.map((row) => {
                        const isSelected =
                          row.kind === "file" &&
                          selected &&
                          (selected.source === "sandbox"
                            ? row.entry.source === "sandbox" &&
                              (row.entry as SandboxFileEntry).path === (selected as SandboxFileEntry).path
                            : row.entry.source !== "sandbox" &&
                              (row.entry as StorageFileEntry).storagePath ===
                                (selected as StorageFileEntry).storagePath);

                        const key =
                          row.kind === "storage-folder"
                            ? `sf:${row.source}:${row.folder}`
                            : row.kind === "sandbox-dir"
                              ? `sd:${row.path}`
                              : row.entry.source === "sandbox"
                                ? `sb:${(row.entry as SandboxFileEntry).path}`
                                : `${(row.entry as StorageFileEntry).bucket}:${(row.entry as StorageFileEntry).storagePath}`;

                        const icon =
                          row.kind === "file" ? (
                            <FileText className="w-4 h-4 opacity-60" />
                          ) : (
                            <Folder className="w-4 h-4 opacity-60" />
                          );

                        const title =
                          row.kind === "storage-folder"
                            ? row.name
                            : row.kind === "sandbox-dir"
                              ? row.name
                              : row.entry.name;

                        const secondary =
                          row.kind === "storage-folder"
                            ? `${row.count} item${row.count === 1 ? "" : "s"}`
                            : row.kind === "sandbox-dir"
                              ? row.path
                              : row.displayPath !== row.entry.name
                                ? row.displayPath
                                : "";

                        const size = row.kind === "file" ? formatBytes(row.entry.size) : "";

                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => {
                              if (row.kind === "sandbox-dir") {
                                setSandboxPath(row.path);
                                setSelected(null);
                                setRenameOpen(false);
                                clearPreview();
                                return;
                              }
                              if (row.kind === "storage-folder") {
                                const next = normalizeRelFolder(row.folder);
                                if (row.source === "uploads") setUploadsFolder(next);
                                if (row.source === "outputs") setOutputsFolder(next);
                                setSelected(null);
                                setRenameOpen(false);
                                clearPreview();
                                return;
                              }
                              if (!isMdUp) {
                                setMobileView("preview");
                              }
                              setSelected(row.entry);
                              setRenameOpen(false);
                            }}
                            className={`w-full flex items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors ${
                              row.kind === "file" && isSelected
                                ? isDark
                                  ? "bg-white/10"
                                  : "bg-zinc-100"
                                : isDark
                                  ? "hover:bg-white/5"
                                  : "hover:bg-zinc-50"
                            }`}
                          >
                            {icon}
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium truncate">{title}</div>
                              {secondary ? <div className={`text-[11px] truncate ${mutedTone}`}>{secondary}</div> : null}
                            </div>
                            {row.kind === "file" ? (
                              <div className={`text-[11px] shrink-0 ${mutedTone}`}>{size}</div>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Preview column */}
              <div
                className={`min-h-0 overflow-y-auto border-t md:border-t-0 ${dividerTone} ${
                  isMobileList ? "hidden" : "block"
                }`}
              >
                <div className="p-4 sm:p-5 space-y-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
                  {!isMdUp ? (
                    <button
                      type="button"
                      onClick={() => setMobileView("list")}
                      className={`inline-flex items-center gap-2 text-xs font-medium rounded-full border px-3 py-2 transition-colors ${
                        isDark ? "border-white/10 bg-white/5 text-white/70 hover:bg-white/10" : "border-zinc-200/70 bg-white text-zinc-600 hover:bg-zinc-50"
                      }`}
                      aria-label="Back to file list"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      Back to list
                    </button>
                  ) : null}
                  <div className="space-y-1">
                    <div className="text-sm font-semibold truncate">{selectedTitle}</div>
                    <div className={`text-xs ${mutedTone} truncate`}>
                      {selected
                        ? selected.source === "sandbox"
                          ? (selected as SandboxFileEntry).path
                          : storageRelativePath(selected as StorageFileEntry)
                        : "Pick a file to preview, download, or attach."}
                    </div>
                  </div>

                  {selected ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={copyReferenceSelected}
                        disabled={actionBusy.length > 0}
                        className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                          isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                        }`}
                      >
                        <Copy className="w-4 h-4 opacity-70" />
                        Copy ref
                      </button>

                      {onAttach ? (
                        <button
                          type="button"
                          onClick={attachSelected}
                          disabled={actionBusy.length > 0}
                          className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                            isDark
                              ? "border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10"
                              : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                          }`}
                        >
                          <Paperclip className="w-4 h-4 opacity-70" />
                          Attach
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={downloadSelected}
                        disabled={actionBusy.length > 0}
                        className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                          isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                        }`}
                      >
                        <Download className="w-4 h-4 opacity-70" />
                        Download
                      </button>

                      {selected.source !== "sandbox" ? (
                        <>
                          <button
                            type="button"
                            onClick={openRename}
                            disabled={actionBusy.length > 0}
                            className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                              isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                            }`}
                          >
                            <Pencil className="w-4 h-4 opacity-70" />
                            Rename/Move
                          </button>
                          <button
                            type="button"
                            onClick={deleteSelected}
                            disabled={actionBusy.length > 0}
                            className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                              isDark
                                ? "border-red-500/30 text-red-200 hover:bg-red-500/10"
                                : "border-red-200 text-red-600 hover:bg-red-50"
                            }`}
                          >
                            <Trash2 className="w-4 h-4 opacity-70" />
                            Delete
                          </button>
                        </>
                      ) : null}

                      {selected.source !== "sandbox" ? (
                        <button
                          type="button"
                          onClick={copyToSandbox}
                          disabled={actionBusy.length > 0}
                          className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                            isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                          }`}
                        >
                          <Copy className="w-4 h-4 opacity-70" />
                          Copy to sandbox
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={persistSandbox}
                          disabled={actionBusy.length > 0}
                          className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                            isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                          }`}
                        >
                          <Copy className="w-4 h-4 opacity-70" />
                          Persist to outputs
                        </button>
                      )}

                      {isTextLikeName(selected.name) ? (
                        selected.source === "sandbox" && !canWriteSandboxPath((selected as SandboxFileEntry).path) ? null : previewMode === "edit" ? (
                          <button
                            type="button"
                            onClick={saveEdit}
                            disabled={actionBusy.length > 0}
                            className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                              isDark
                                ? "border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10"
                                : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                            }`}
                          >
                            <Save className="w-4 h-4 opacity-70" />
                            Save
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={startEdit}
                            disabled={actionBusy.length > 0}
                            className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                              isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                            }`}
                          >
                            <Pencil className="w-4 h-4 opacity-70" />
                            Edit
                          </button>
                        )
                      ) : null}
                    </div>
                  ) : null}

                  {activeSource === "sandbox" && sandboxSessionId ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={persistSandboxFolder}
                        disabled={actionBusy.length > 0}
                        className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border transition-colors ${
                          isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-zinc-50"
                        }`}
                      >
                        <Copy className="w-4 h-4 opacity-70" />
                        Persist current folder
                      </button>
                      <div className={`text-[11px] self-center ${mutedTone}`}>
                        {sandboxPath}
                      </div>
                    </div>
                  ) : null}

                  {renameOpen && selected && selected.source !== "sandbox" ? (
                    <div
                      className={`rounded-2xl border p-3 space-y-2 ${
                        isDark ? "border-white/10 bg-white/5" : "border-zinc-200/70 bg-zinc-50"
                      }`}
                    >
                      <div className="text-xs font-semibold">Move / Rename</div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          value={renameFolder}
                          onChange={(e) => setRenameFolder(e.target.value)}
                          placeholder="folder (optional)"
                          className={`text-xs rounded-xl border px-3 py-2 bg-transparent ${
                            isDark ? "border-white/10" : "border-zinc-200/70"
                          }`}
                        />
                        <input
                          value={renameName}
                          onChange={(e) => setRenameName(e.target.value)}
                          placeholder="filename.ext"
                          className={`text-xs rounded-xl border px-3 py-2 bg-transparent ${
                            isDark ? "border-white/10" : "border-zinc-200/70"
                          }`}
                        />
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setRenameOpen(false)}
                          className={`text-xs px-3 py-2 rounded-full border ${
                            isDark ? "border-white/10 hover:bg-white/10" : "border-zinc-200/70 hover:bg-white"
                          }`}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={performMove}
                          disabled={actionBusy.length > 0}
                          className={`text-xs px-3 py-2 rounded-full border ${
                            isDark
                              ? "border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10"
                              : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                          }`}
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {previewError ? <div className="text-xs text-red-500">{previewError}</div> : null}
                  {previewLoading ? <div className={`text-xs ${mutedTone}`}>Loading preview…</div> : null}

                  {selected && previewMode === "edit" ? (
                    <textarea
                      value={previewText}
                      onChange={(e) => setPreviewText(e.target.value)}
                      className={`w-full min-h-[320px] text-xs rounded-2xl border p-3 font-mono bg-transparent ${
                        isDark ? "border-white/10" : "border-zinc-200/70"
                      }`}
                    />
                  ) : previewUrl ? (
                    <div className={`rounded-2xl border overflow-hidden ${isDark ? "border-white/10" : "border-zinc-200/70"}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={previewUrl} alt={selectedTitle} className="w-full h-auto" />
                    </div>
                  ) : previewText ? (
                    previewKind === "python" ? (
                      <div className={`rounded-2xl border overflow-hidden ${isDark ? "border-white/10" : "border-zinc-200/70"}`}>
                        <SyntaxHighlighter
                          language="python"
                          style={isDark ? oneDark : oneLight}
                          showLineNumbers
                          wrapLongLines
                          customStyle={{
                            margin: 0,
                            padding: "12px",
                            background: "transparent",
                            fontSize: "12px",
                          }}
                          lineNumberStyle={{
                            minWidth: "2.25em",
                            paddingRight: "12px",
                            color: isDark ? "#71717a" : "#a1a1aa",
                          }}
                        >
                          {previewText}
                        </SyntaxHighlighter>
                      </div>
                    ) : previewKind === "csv" && csvPreview ? (
                      <div className="space-y-2">
                        <div className={`text-[11px] ${mutedTone}`}>
                          Showing {csvPreview.rows.length} row{csvPreview.rows.length === 1 ? "" : "s"} and{" "}
                          {csvPreview.columnCount} column{csvPreview.columnCount === 1 ? "" : "s"}
                          {csvPreview.truncatedRows ? ". More rows not shown." : "."}
                          {csvPreview.truncatedColumns ? " Some columns hidden." : ""}
                        </div>
                        <div
                          className={`rounded-2xl border overflow-auto max-h-[420px] ${
                            isDark ? "border-white/10 bg-white/5" : "border-zinc-200/70 bg-white"
                          }`}
                        >
                          <table className="min-w-full text-xs">
                            <thead className={isDark ? "bg-white/10 text-zinc-200" : "bg-zinc-50 text-zinc-700"}>
                              <tr>
                                {Array.from({ length: csvPreview.columnCount }).map((_, idx) => (
                                  <th
                                    key={`csv-head-${idx}`}
                                    className="sticky top-0 border-b border-inherit px-2 py-2 text-left font-semibold"
                                  >
                                    {csvPreview.rows[0]?.[idx] ?? ""}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {csvPreview.rows.slice(1).map((row, rowIdx) => (
                                <tr key={`csv-row-${rowIdx}`} className={rowIdx % 2 === 0 ? (isDark ? "bg-white/0" : "bg-white") : (isDark ? "bg-white/5" : "bg-zinc-50")}>
                                  {Array.from({ length: csvPreview.columnCount }).map((_, colIdx) => (
                                    <td key={`csv-cell-${rowIdx}-${colIdx}`} className="px-2 py-1.5 align-top">
                                      {row[colIdx] ?? ""}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : (
                      <pre
                        className={`text-xs whitespace-pre-wrap break-words rounded-2xl border p-3 font-mono ${
                          isDark ? "border-white/10 bg-white/5" : "border-zinc-200/70 bg-zinc-50"
                        }`}
                      >
                        {previewText}
                      </pre>
                    )
                  ) : selected ? (
                    <div className={`text-xs ${mutedTone}`}>No preview available.</div>
                  ) : (
                    <div className={`text-xs ${mutedTone}`}>Select a file to preview.</div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

