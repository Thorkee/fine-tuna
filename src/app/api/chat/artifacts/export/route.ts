import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import HTMLtoDOCX from "html-to-docx";
import * as XLSX from "xlsx";

import { AgentPersistence } from "@/lib/agent/persistence";
import { normalizeDocumentHtml } from "@/lib/markdown";
import { createClient } from "@/lib/supabase/server";
import { createStorageSignedUrl, uploadStorageObject } from "@/lib/supabase/storage";
import type { AgentArtifact } from "@/lib/agent/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportPayload = {
  chatId: string;
  artifactId: string;
  type: "document" | "spreadsheet";
};

type SpreadsheetSheet = {
  id?: string;
  name?: string;
  order?: number;
  status?: number;
  row?: number;
  column?: number;
  celldata?: Array<{ r: number; c: number; v: unknown }>;
};

type SpreadsheetArtifactData = {
  kind: "spreadsheet";
  title?: string;
  sheets: SpreadsheetSheet[];
  updatedAt?: string;
  version?: number;
};

type CellValue = string | number | boolean | Date;

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
  return normalized ? normalized : null;
}

function normalizeSheets(data: unknown): SpreadsheetSheet[] {
  if (Array.isArray(data)) return data as SpreadsheetSheet[];
  if (isRecord(data) && Array.isArray(data.sheets)) return data.sheets as SpreadsheetSheet[];
  return [];
}

function spreadsheetToWorkbook(data: SpreadsheetArtifactData): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const sheets = normalizeSheets(data);
  sheets.forEach((sheet, idx) => {
    const ws: XLSX.WorkSheet = {};
    const celldata = sheet.celldata ?? [];
    let maxR = 0;
    let maxC = 0;
    celldata.forEach((cell) => {
      const addr = XLSX.utils.encode_cell({ r: cell.r, c: cell.c });
      const raw = cell.v;
      let cellObj: XLSX.CellObject;
      const toCellValue = (value: unknown): CellValue => {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
        if (value instanceof Date) return value;
        return "";
      };
      if (isRecord(raw)) {
        const v = toCellValue(raw.v);
        cellObj = {
          v,
          t:
            typeof raw.t === "string"
              ? (raw.t as XLSX.ExcelDataType)
              : typeof v === "number"
                ? "n"
                : typeof v === "boolean"
                  ? "b"
                  : v instanceof Date
                    ? "d"
                    : "s",
        };
        if (typeof raw.f === "string") cellObj.f = raw.f;
        if (typeof raw.z === "string") cellObj.z = raw.z;
      } else {
        const v = toCellValue(raw);
        cellObj = {
          v,
          t: typeof v === "number" ? "n" : typeof v === "boolean" ? "b" : v instanceof Date ? "d" : "s",
        };
      }
      ws[addr] = cellObj;
      if (cell.r > maxR) maxR = cell.r;
      if (cell.c > maxC) maxC = cell.c;
    });
    if (typeof sheet.row === "number") maxR = Math.max(maxR, sheet.row - 1);
    if (typeof sheet.column === "number") maxC = Math.max(maxC, sheet.column - 1);
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    XLSX.utils.book_append_sheet(wb, ws, sheet.name || `Sheet${idx + 1}`);
  });
  return wb;
}

function safeFileName(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}

export async function POST(req: NextRequest) {
  const payload = (await req.json().catch(() => null)) as ExportPayload | null;
  const chatId = payload?.chatId?.trim();
  const artifactId = payload?.artifactId?.trim();
  const type = payload?.type;
  if (!chatId || !artifactId || (type !== "document" && type !== "spreadsheet")) {
    return Response.json({ error: "Missing payload" }, { status: 400 });
  }

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .eq("user_id", authedUserId)
    .maybeSingle();

  if (chatErr || !chatRow) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const state = await AgentPersistence.loadState(chatId);
  if (!state) {
    return Response.json({ error: "Agent state not found" }, { status: 404 });
  }

  const artifact = state.artifacts.find((a: AgentArtifact) => a.id === artifactId);
  if (!artifact) {
    return Response.json({ error: "Artifact not found" }, { status: 404 });
  }

  let fileBuffer: Buffer;
  let contentType: string;
  let extension: string;

  if (type === "document") {
    const html = extractHtml(artifact.content) ?? "<p></p>";
    const docx = await HTMLtoDOCX(html, null, {
      title: artifact.title || "Document",
      creator: "tuna",
    });
    fileBuffer = Buffer.isBuffer(docx) ? docx : Buffer.from(docx as ArrayBuffer);
    contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    extension = "docx";
  } else {
    const spreadsheetData = (isRecord(artifact.content) ? artifact.content : null) as SpreadsheetArtifactData | null;
    const wb = spreadsheetData ? spreadsheetToWorkbook(spreadsheetData) : XLSX.utils.book_new();
    const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    fileBuffer = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
    contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    extension = "xlsx";
  }

  const safeId = safeFileName(artifactId) || "artifact";
  const fileName = `${safeId}-${randomUUID().slice(0, 8)}.${extension}`;
  const storagePath = `exports/${chatId}/${fileName}`;

  try {
    await uploadStorageObject("artifacts", storagePath, fileBuffer, { contentType });
    const signedUrl = await createStorageSignedUrl("artifacts", storagePath, 60 * 10);
    return Response.json({ url: signedUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export artifact";
    return Response.json({ error: message }, { status: 500 });
  }
}
