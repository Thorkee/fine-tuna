"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Workbook } from "@fortune-sheet/react";
import type { Cell, CellWithRowAndCol, Sheet } from "@fortune-sheet/core";
import * as XLSX from "xlsx";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Table2,
  Upload,
} from "lucide-react";

import { useArtifactChatId } from "@/lib/artifact-scope";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";

type SpreadsheetSheet = Sheet;

type SpreadsheetArtifactData = {
  kind: "spreadsheet";
  title?: string;
  sheets: SpreadsheetSheet[];
  updatedAt?: string;
  version?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSheets(data: unknown): SpreadsheetSheet[] {
  const raw = Array.isArray(data)
    ? (data as SpreadsheetSheet[])
    : isRecord(data) && Array.isArray(data.sheets)
      ? (data.sheets as SpreadsheetSheet[])
      : [];

  return raw.map((sheet, idx) => ({
    ...sheet,
    name: sheet.name?.trim() || `Sheet${idx + 1}`,
  }));
}

function extractTitle(data: unknown): string | null {
  if (!data || !isRecord(data)) return null;
  const title = data.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

function buildDefaultSheet(): SpreadsheetSheet[] {
  return [
    {
      id: "sheet-1",
      name: "Sheet1",
      order: 0,
      status: 1,
      row: 30,
      column: 12,
      celldata: [],
    },
  ];
}

function workbookToFortune(wb: XLSX.WorkBook): SpreadsheetSheet[] {
  return wb.SheetNames.map((name, idx) => {
    const ws = wb.Sheets[name]!;
    const celldata: CellWithRowAndCol[] = [];
    Object.keys(ws).forEach((key) => {
      if (key.startsWith("!")) return;
      const cell = ws[key] as XLSX.CellObject;
      const pos = XLSX.utils.decode_cell(key);
      const rawValue = cell.v instanceof Date ? cell.v.toISOString() : cell.v;
      const cellValue =
        typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean"
          ? rawValue
          : "";
      const value: Cell = {
        v: cellValue,
      };
      if (typeof cell.f === "string") value.f = cell.f;
      celldata.push({ r: pos.r, c: pos.c, v: value });
    });
    const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"] as string) : null;
    return {
      id: `sheet-${idx + 1}`,
      name,
      order: idx,
      status: 1,
      row: range ? range.e.r + 1 : 30,
      column: range ? range.e.c + 1 : 12,
      celldata,
    };
  });
}

export default function SpreadsheetArtifact(props: {
  artifactId?: string;
  dataOverride?: unknown;
  chatId?: string | null;
}) {
  const artifactId = props.artifactId ?? "spreadsheet";
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

  const isReadOnly = dataOverride !== undefined;

  const [title, setTitle] = useState(() => extractTitle(resolvedData) ?? "Spreadsheet");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedKeyRef = useRef<string | null>(null);

  const [sheetData, setSheetData] = useState<SpreadsheetSheet[]>(() => {
    const normalized = normalizeSheets(resolvedData);
    return normalized.length > 0 ? normalized : buildDefaultSheet();
  });

  useEffect(() => {
    const normalized = normalizeSheets(resolvedData);
    if (normalized.length > 0) {
      setSheetData(normalized);
    }
  }, [resolvedData]);

  useEffect(() => {
    const nextTitle = extractTitle(resolvedData);
    if (nextTitle) setTitle(nextTitle);
  }, [resolvedData]);

  const scheduleSave = (nextData: SpreadsheetSheet[], nextTitle?: string) => {
    if (isReadOnly) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void persistSpreadsheet(nextData, nextTitle ?? title);
    }, 650);
  };

  const persistSpreadsheet = async (nextData: SpreadsheetSheet[], nextTitle: string) => {
    if (!chatId) return;
    const payload: SpreadsheetArtifactData = {
      kind: "spreadsheet",
      title: nextTitle,
      sheets: nextData,
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    const key = JSON.stringify(payload);
    if (key === lastSavedKeyRef.current) return;

    setStatus("saving");
    setLastError(null);
    try {
      addArtifact({ id: artifactId, type: "spreadsheet", data: payload });
      const res = await fetch("/api/chat/artifacts/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          artifact: { id: artifactId, type: "spreadsheet", data: payload },
        }),
      });
      if (!res.ok) {
        throw new Error(`Save failed (${res.status})`);
      }
      lastSavedKeyRef.current = key;
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1200);
    } catch (error) {
      setStatus("error");
      setLastError(error instanceof Error ? error.message : "Save failed");
    }
  };

  const handleTitleChange = (value: string) => {
    setTitle(value);
    scheduleSave(sheetData, value);
  };

  const handleImportXlsx = async (file: File) => {
    setIsImporting(true);
    setLastError(null);
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array", cellFormula: true, cellStyles: false });
      const sheets = workbookToFortune(wb);
      setSheetData(sheets);
      const nextTitle = file.name.replace(/\.xlsx$/i, "") || title;
      setTitle(nextTitle);
      scheduleSave(sheets, nextTitle);
    } catch (error) {
      setStatus("error");
      setLastError(error instanceof Error ? error.message : "Import failed");
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
          type: "spreadsheet",
        }),
      });
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`);
      }
      const payload = (await res.json()) as { url?: string };
      if (!payload.url) throw new Error("Export failed");
      window.open(payload.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setStatus("error");
      setLastError(error instanceof Error ? error.message : "Export failed");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-primary text-primary">
      <div className="shrink-0 border-b border-zinc-200/70 dark:border-white/10 px-3 sm:px-4 py-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-2 text-[14px] font-semibold">
              <Table2 className="w-4 h-4 text-[hsl(var(--accent-blue))]" />
              <input
                value={title}
                onChange={(e) => handleTitleChange(e.target.value)}
                disabled={isReadOnly}
                className="bg-transparent outline-none border-b border-transparent focus:border-zinc-400/70 dark:focus:border-white/30 transition-colors"
                placeholder="Spreadsheet title"
              />
            </div>
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
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportXlsx(file);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isReadOnly || isImporting}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                isReadOnly || isImporting
                  ? "bg-zinc-100 dark:bg-white/5 text-zinc-400 cursor-not-allowed"
                  : "bg-zinc-900 text-white dark:bg-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200"
              }`}
            >
              <Upload className="w-4 h-4" />
              Import XLSX
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={isExporting}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                isExporting
                  ? "bg-zinc-100 dark:bg-white/5 text-zinc-400 cursor-not-allowed"
                  : "bg-zinc-900 text-white dark:bg-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200"
              }`}
            >
              <Download className="w-4 h-4" />
              Export XLSX
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-primary">
        <div className={`h-full ${isReadOnly ? "pointer-events-none opacity-90" : ""}`}>
          <Workbook
            data={sheetData}
            onChange={(next: SpreadsheetSheet[]) => {
              setSheetData(next);
              scheduleSave(next);
            }}
          />
        </div>
      </div>
    </div>
  );
}
