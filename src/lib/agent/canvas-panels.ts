export const SANDBOX_PANEL_IDS = [
  "sandbox-code",
  "sandbox-terminal",
  "sandbox-files",
  "sandbox-browser",
] as const;

export type SandboxPanelId = typeof SANDBOX_PANEL_IDS[number];
export type CanvasPanelId = SandboxPanelId | string;

export const PLACEHOLDER_CANVAS_IDS: ReadonlySet<string> = new Set();

export function isSandboxPanelId(panelId: string): panelId is SandboxPanelId {
  return (SANDBOX_PANEL_IDS as readonly string[]).includes(panelId);
}

export function panelToArtifactId(panelId: CanvasPanelId): string {
  return isSandboxPanelId(panelId) ? "sandbox" : panelId;
}

export function defaultPanelForArtifact(artifactId: string): CanvasPanelId | null {
  const trimmed = String(artifactId || "").trim();
  if (!trimmed) return null;
  if (trimmed === "sandbox") return "sandbox-terminal";
  return trimmed;
}
