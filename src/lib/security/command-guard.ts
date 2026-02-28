const BLOCKED_COMMAND_MESSAGE = "Command blocked by policy.";

const SEGMENT_SPLIT_RE = /(?:\r?\n|&&|\|\||;|\|)/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const WRAPPER_TOKENS = new Set(["sudo", "env", "command"]);

function splitSegments(input: string): string[] {
  return input.split(SEGMENT_SPLIT_RE);
}

function isAssignment(token: string): boolean {
  return ASSIGNMENT_RE.test(token);
}

function stripWrappers(tokens: string[]): string[] {
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (isAssignment(token)) {
      idx += 1;
      continue;
    }
    if (WRAPPER_TOKENS.has(token)) {
      idx += 1;
      continue;
    }
    break;
  }
  return tokens.slice(idx);
}

function normalizeTokens(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return stripWrappers(tokens);
}

function isRmCommand(token: string): boolean {
  const base = token.split("/").pop()?.toLowerCase();
  return base === "rm" || base === "rm.exe";
}

function hasRecursiveAndForce(args: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--recursive") recursive = true;
    if (arg === "--force") force = true;
    if (arg.startsWith("--")) continue;
    if (arg.startsWith("-") && arg.length > 1) {
      if (arg.includes("r")) recursive = true;
      if (arg.includes("f")) force = true;
    }
  }
  return recursive && force;
}

export function findBlockedCommandReason(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const normalized = input.replace(/\r/g, "\n");
  for (const segment of splitSegments(normalized)) {
    const tokens = normalizeTokens(segment);
    if (tokens.length === 0) continue;
    const [command, ...args] = tokens;
    if (!isRmCommand(command)) continue;
    if (hasRecursiveAndForce(args)) return BLOCKED_COMMAND_MESSAGE;
  }
  return null;
}
