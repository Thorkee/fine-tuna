export type MetricPoint = {
  step?: number;
  epoch?: number;
  loss?: number;
  evalLoss?: number;
  lr?: number;
  accuracy?: number;
  evalAccuracy?: number;
  [key: string]: number | undefined;
};

const KNOWN_ALIASES: Record<string, string> = {
  loss: "loss",
  train_loss: "loss",
  training_loss: "loss",
  train_loss_step: "loss",
  eval_loss: "evalLoss",
  validation_loss: "evalLoss",
  val_loss: "evalLoss",
  learning_rate: "lr",
  lr: "lr",
  accuracy: "accuracy",
  train_accuracy: "accuracy",
  train_acc: "accuracy",
  acc: "accuracy",
  eval_accuracy: "evalAccuracy",
  eval_acc: "evalAccuracy",
  val_accuracy: "evalAccuracy",
  val_acc: "evalAccuracy",
  step: "step",
  global_step: "step",
  epoch: "epoch",
};

function canonicalize(key: string): string {
  const k = key.trim().toLowerCase().replace(/[- ]/g, "_");
  return KNOWN_ALIASES[k] ?? k;
}

function toNum(v: string): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * HuggingFace Trainer prints dicts like: {'loss': 0.5, 'learning_rate': 5e-05, 'epoch': 1.0}
 * Also matches JSON-style with double quotes.
 */
const HF_DICT_RE = /\{[^}]*(?:'[^']*'\s*:\s*[\d.eE+-]+[^}]*)+\}/g;
const HF_KV_RE = /['"]?([\w]+)['"]?\s*:\s*([\d.eE+-]+)/g;

function parseHfDict(line: string, results: MetricPoint[]): boolean {
  HF_DICT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = HF_DICT_RE.exec(line)) !== null) {
    const block = match[0];
    const point: MetricPoint = {};
    HF_KV_RE.lastIndex = 0;
    let kvMatch: RegExpExecArray | null;
    let hasMetric = false;
    while ((kvMatch = HF_KV_RE.exec(block)) !== null) {
      const key = canonicalize(kvMatch[1]);
      const val = toNum(kvMatch[2]);
      if (val !== undefined) {
        (point as Record<string, number | undefined>)[key] = val;
        if (key !== "step" && key !== "epoch") hasMetric = true;
      }
    }
    if (hasMetric) {
      results.push(point);
      found = true;
    }
  }
  return found;
}

/**
 * Key=value format: epoch=1 loss=0.5 eval_loss=0.3 lr=5e-5
 */
const KV_EQ_RE = /([\w]+)\s*=\s*([\d.eE+-]+)/g;

function parseKvEquals(line: string, results: MetricPoint[]): boolean {
  KV_EQ_RE.lastIndex = 0;
  const point: MetricPoint = {};
  let kvMatch: RegExpExecArray | null;
  let hasMetric = false;
  while ((kvMatch = KV_EQ_RE.exec(line)) !== null) {
    const key = canonicalize(kvMatch[1]);
    const val = toNum(kvMatch[2]);
    if (val !== undefined) {
      (point as Record<string, number | undefined>)[key] = val;
      if (key !== "step" && key !== "epoch") hasMetric = true;
    }
  }
  if (hasMetric) {
    results.push(point);
    return true;
  }
  return false;
}

/**
 * Tabular / pipe-separated: Step 100 | train_loss: 0.45 | eval_loss: 0.38
 * Also colon-separated without pipes: loss: 0.45, eval_loss: 0.38
 */
const PIPE_KV_RE = /([\w]+)\s*[:=]\s*([\d.eE+-]+)/g;
const STEP_PREFIX_RE = /(?:step|iteration)\s*[:=]?\s*([\d]+)/i;

function parsePipeTable(line: string, results: MetricPoint[]): boolean {
  if (!line.includes("|") && !line.includes(":")) return false;

  PIPE_KV_RE.lastIndex = 0;
  const point: MetricPoint = {};
  let kvMatch: RegExpExecArray | null;
  let hasMetric = false;

  const stepMatch = STEP_PREFIX_RE.exec(line);
  if (stepMatch) {
    const s = toNum(stepMatch[1]);
    if (s !== undefined) point.step = s;
  }

  while ((kvMatch = PIPE_KV_RE.exec(line)) !== null) {
    const key = canonicalize(kvMatch[1]);
    const val = toNum(kvMatch[2]);
    if (val !== undefined) {
      (point as Record<string, number | undefined>)[key] = val;
      if (key !== "step" && key !== "epoch") hasMetric = true;
    }
  }
  if (hasMetric) {
    results.push(point);
    return true;
  }
  return false;
}

function fingerprint(p: MetricPoint): string {
  const parts: string[] = [];
  if (p.step !== undefined) parts.push(`s${p.step}`);
  if (p.epoch !== undefined) parts.push(`e${p.epoch}`);
  if (p.loss !== undefined) parts.push(`l${p.loss}`);
  if (p.evalLoss !== undefined) parts.push(`v${p.evalLoss}`);
  return parts.join("|");
}

export function parseTrainingMetrics(stdout: string): MetricPoint[] {
  if (!stdout || typeof stdout !== "string") return [];

  const lines = stdout.split("\n");
  const raw: MetricPoint[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (parseHfDict(trimmed, raw)) continue;
    if (parseKvEquals(trimmed, raw)) continue;
    parsePipeTable(trimmed, raw);
  }

  // Deduplicate by fingerprint
  const seen = new Set<string>();
  const deduped: MetricPoint[] = [];
  for (const p of raw) {
    const fp = fingerprint(p);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    deduped.push(p);
  }

  // Assign synthetic step indices if no step/epoch present
  const hasStep = deduped.some((p) => p.step !== undefined);
  const hasEpoch = deduped.some((p) => p.epoch !== undefined);
  if (!hasStep && !hasEpoch) {
    for (let i = 0; i < deduped.length; i++) {
      deduped[i].step = i + 1;
    }
  }

  return deduped;
}
