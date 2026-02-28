"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";

export type ClarificationOption = {
  id: string;
  label: string;
  description?: string;
  value?: string;
};

export type ClarificationQuestionType =
  | "multiple_choice"
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "boolean";

export type ClarificationQuestion = {
  id: string;
  prompt: string;
  help?: string;
  /**
   * When omitted:
   * - If `options` is provided, defaults to `multiple_choice`
   * - Otherwise defaults to `text`
   */
  type?: ClarificationQuestionType;
  allow_multiple?: boolean;
  required?: boolean;
  /**
   * For `multiple_choice` questions, provide at least 1 option.
   * For other question types, omit `options` and the UI will render an input.
   */
  options?: ClarificationOption[];
  /** For multiple_choice only; defaults to true. */
  allow_custom?: boolean;
  /** Label for the multiple_choice custom input (defaults to "Add details"). */
  custom_label?: string;
  placeholder?: string;
  rows?: number;
  min?: number;
  max?: number;
  step?: number;
};

export type ClarificationPayload = {
  version?: number;
  title?: string;
  description?: string;
  response_format?: string;
  submit_label?: string;
  layout?: "stacked" | "stepper";
  questions: ClarificationQuestion[];
};

export type ClarificationResponseState = {
  answers: Record<string, string[]>;
  customAnswers: Record<string, string>;
  notes?: string;
  responseText?: string;
  answeredAt?: string;
};

type ClarificationCardProps = {
  payload: ClarificationPayload;
  disabled?: boolean;
  onSend: (response: string) => void;
  onInsert?: (response: string) => void;
  onRecordResponse?: (response: ClarificationResponseState) => void;
  initialAnswers?: Record<string, string[]>;
  initialCustomAnswers?: Record<string, string>;
  initialNotes?: string;
};

const CLARIFICATION_BLOCK = /```clarification\s*([\s\S]*?)```/i;
const CLARIFICATION_OPEN = /```clarification\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findJsonObjectEndIndex(source: string, startIndex: number): number | null {
  if (startIndex < 0 || startIndex >= source.length) return null;
  if (source[startIndex] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return null;
    }
  }
  return null;
}

function extractLeadingJsonObject(content: string): { json: string; stripped: string } | null {
  const firstNonWhitespace = content.search(/\S/);
  if (firstNonWhitespace === -1) return null;
  if (content[firstNonWhitespace] !== "{") return null;
  const end = findJsonObjectEndIndex(content, firstNonWhitespace);
  if (end === null) return null;
  const json = content.slice(firstNonWhitespace, end + 1);
  const stripped = content.slice(end + 1).trim();
  return { json, stripped };
}

export function isClarificationPayload(value: unknown): value is ClarificationPayload {
  if (!isRecord(value)) return false;
  const questions = value.questions;
  if (!Array.isArray(questions) || questions.length === 0) return false;
  for (const question of questions) {
    if (!isRecord(question)) return false;
    if (typeof question.id !== "string" || !question.id.trim()) return false;
    if (typeof question.prompt !== "string" || !question.prompt.trim()) return false;
    const typeRaw = question.type;
    const hasOptions = Array.isArray(question.options) && question.options.length > 0;
    const inferredType: ClarificationQuestionType = hasOptions ? "multiple_choice" : "text";
    const type: ClarificationQuestionType =
      typeof typeRaw === "string" ? (typeRaw as ClarificationQuestionType) : inferredType;

    const allowedTypes: ReadonlySet<string> = new Set([
      "multiple_choice",
      "text",
      "textarea",
      "number",
      "date",
      "boolean",
    ]);
    if (typeof typeRaw === "string" && !allowedTypes.has(typeRaw)) return false;

    if (type === "multiple_choice") {
      if (!hasOptions) return false;
    }

    if (hasOptions) {
      for (const option of question.options as ClarificationOption[]) {
        if (!isRecord(option)) return false;
        if (typeof option.id !== "string" || !option.id.trim()) return false;
        if (typeof option.label !== "string" || !option.label.trim()) return false;
      }
    }
  }
  return true;
}

export function extractClarificationPayload(content: string): {
  payload: ClarificationPayload | null;
  stripped: string;
} {
  const match = content.match(CLARIFICATION_BLOCK);
  if (match) {
    const stripped = content.replace(match[0], "").trim();
    try {
      const raw = match[1].trim();
      const parsed: unknown = JSON.parse(raw);
      if (!isClarificationPayload(parsed)) {
        return { payload: null, stripped };
      }
      return { payload: parsed, stripped };
    } catch {
      return { payload: null, stripped };
    }
  }

  const leadingJson = extractLeadingJsonObject(content);
  if (leadingJson) {
    try {
      const parsed: unknown = JSON.parse(leadingJson.json);
      if (isClarificationPayload(parsed)) {
        return { payload: parsed, stripped: leadingJson.stripped };
      }
    } catch {
      // Ignore parsing failures and fall through.
    }
  }

  const openMatch = content.match(CLARIFICATION_OPEN);
  if (openMatch && typeof openMatch.index === "number") {
    return { payload: null, stripped: content.slice(0, openMatch.index).trim() };
  }

  return { payload: null, stripped: content };
}

function getOptionToken(option: ClarificationOption): string {
  return option.value || option.id || option.label;
}

function resolveAnswerText(
  question: ClarificationQuestion,
  selected: string[],
  custom?: string
): string {
  const options = Array.isArray(question.options) ? question.options : [];
  const tokens = selected
    .map((id) => options.find((opt) => opt.id === id))
    .filter(Boolean)
    .map((opt) => getOptionToken(opt as ClarificationOption));
  if (custom && custom.trim()) {
    tokens.push(custom.trim());
  }
  return tokens.length > 0 ? tokens.join(", ") : selected.join(", ");
}

function hasQuestionAnswer(
  questionId: string,
  answers: Record<string, string[]>,
  customAnswers: Record<string, string>
): boolean {
  const selected = answers[questionId] || [];
  const custom = customAnswers[questionId];
  return selected.length > 0 || Boolean(custom?.trim());
}

function findFirstUnansweredIndex(
  questions: ClarificationQuestion[],
  answers: Record<string, string[]>,
  customAnswers: Record<string, string>
): number {
  const idx = questions.findIndex((question) => !hasQuestionAnswer(question.id, answers, customAnswers));
  return idx === -1 ? 0 : idx;
}

function buildResponsePreview(
  payload: ClarificationPayload,
  answers: Record<string, string[]>,
  customAnswers: Record<string, string>
): string {
  const template = payload.response_format;
  const hasPlaceholders =
    typeof template === "string" && /{{\s*[\w-]+\s*}}/.test(template);

  const getAnswerFor = (questionId: string) => {
    const question = payload.questions.find((q) => q.id === questionId);
    if (!question) return "";
    const selected = answers[questionId] || [];
    const custom = customAnswers[questionId];
    return resolveAnswerText(question, selected, custom);
  };

  if (hasPlaceholders && template) {
    return template.replace(/{{\s*([\w-]+)\s*}}/g, (_, id) => {
      const answer = getAnswerFor(id);
      return answer || "";
    });
  }

  const entries = payload.questions
    .map((question) => {
      const answer = resolveAnswerText(
        question,
        answers[question.id] || [],
        customAnswers[question.id]
      );
      if (!answer) return null;
      return { question: question.prompt, answer };
    })
    .filter(Boolean) as { question: string; answer: string }[];

  if (entries.length === 0) return "";
  if (entries.length === 1) {
    return `Selected answer:\n- ${entries[0].question}: ${entries[0].answer}`;
  }
  return `Selected answers:\n${entries
    .map((entry) => `- ${entry.question}: ${entry.answer}`)
    .join("\n")}`;
}

export default function ClarificationCard(props: ClarificationCardProps) {
  const {
    payload,
    disabled,
    onSend,
    onInsert,
    onRecordResponse,
    initialAnswers,
    initialCustomAnswers,
    initialNotes,
  } = props;
  const [answers, setAnswers] = useState<Record<string, string[]>>(
    () => initialAnswers ?? {}
  );
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>(
    () => initialCustomAnswers ?? {}
  );
  const [notes, setNotes] = useState(initialNotes ?? "");
  const isStepper = payload.layout === "stepper";
  const [stepIndex, setStepIndex] = useState(() => {
    if (!isStepper) return 0;
    return findFirstUnansweredIndex(
      payload.questions,
      initialAnswers ?? {},
      initialCustomAnswers ?? {}
    );
  });

  const responseText = useMemo(() => {
    const base = buildResponsePreview(payload, answers, customAnswers).trim();
    const extra = notes.trim();
    if (!extra) return base;
    return base ? `${base}\n\nAdditional notes: ${extra}` : extra;
  }, [payload, answers, customAnswers, notes]);

  const isComplete = payload.questions.every((question) => {
    if (question.required === false) return true;
    const hasSelections = (answers[question.id] || []).length > 0;
    const hasCustom = Boolean(customAnswers[question.id]?.trim());
    return hasSelections || hasCustom;
  });

  const totalSteps = payload.questions.length;
  const clampedStepIndex = Math.min(Math.max(stepIndex, 0), totalSteps - 1);
  const currentQuestion = isStepper ? payload.questions[clampedStepIndex] : null;
  const isLastStep = isStepper && clampedStepIndex === totalSteps - 1;
  const isFirstStep = isStepper && clampedStepIndex === 0;

  const updateSelection = (
    questionId: string,
    optionId: string,
    allowMultiple?: boolean
  ) => {
    setAnswers((prev) => {
      const current = new Set(prev[questionId] || []);
      if (allowMultiple) {
        if (current.has(optionId)) {
          current.delete(optionId);
        } else {
          current.add(optionId);
        }
      } else {
        current.clear();
        current.add(optionId);
      }
      return { ...prev, [questionId]: Array.from(current) };
    });
  };

  const updateCustomValue = (questionId: string, value: string) => {
    setCustomAnswers((prev) => ({
      ...prev,
      [questionId]: value,
    }));
    if (value.trim()) {
      setAnswers((prev) => ({ ...prev, [questionId]: [] }));
    }
  };

  const canSend = isComplete && Boolean(responseText.trim());
  const handleSend = () => {
    if (!responseText.trim()) return;
    onRecordResponse?.({
      answers,
      customAnswers,
      notes: notes.trim() || undefined,
      responseText,
      answeredAt: new Date().toISOString(),
    });
    onSend(responseText);
  };

  const renderQuestion = (question: ClarificationQuestion) => {
    const selected = new Set(answers[question.id] || []);
    const customValue = customAnswers[question.id] || "";
    const hasCustomValue = Boolean(customValue.trim());
    const hasOptions = Array.isArray(question.options) && question.options.length > 0;
    const type: ClarificationQuestionType =
      question.type ?? (hasOptions ? "multiple_choice" : "text");
    const helper =
      type === "multiple_choice"
        ? question.allow_multiple
          ? "Select all that apply"
          : "Select one"
        : type === "textarea"
          ? "Provide details"
          : type === "number"
            ? "Enter a number"
            : type === "date"
              ? "Pick a date"
              : type === "boolean"
                ? "Select one"
                : "Provide details";

    return (
      <div
        key={question.id}
        className="rounded-lg border border-default bg-secondary p-3 space-y-2"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-[13px] font-semibold text-zinc-900 dark:text-white">
              {question.prompt}
            </div>
            {question.help ? (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {question.help}
              </p>
            ) : null}
          </div>
          <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
            {helper}
          </span>
        </div>
        <div className="grid gap-1.5">
          {type === "multiple_choice" && hasOptions ? (
            <>
              {(question.options as ClarificationOption[]).map((option) => {
                const isSelected = selected.has(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() =>
                      updateSelection(question.id, option.id, question.allow_multiple)
                    }
                    disabled={disabled}
                    aria-pressed={isSelected}
                    className={`w-full text-left rounded-md border px-2.5 py-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300/60 dark:focus-visible:ring-white/20 ${
                      isSelected
                        ? "border-zinc-900/80 dark:border-white bg-zinc-900/5 dark:bg-white/10 shadow-[0_1px_0_rgba(0,0,0,0.08)]"
                        : "border-zinc-200/80 dark:border-white/10 bg-white dark:bg-transparent hover:border-zinc-300/80 dark:hover:border-white/20 hover:bg-zinc-50 dark:hover:bg-white/5"
                    } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`mt-0.5 h-3.5 w-3.5 rounded-full border flex items-center justify-center text-[9px] ${
                          isSelected
                            ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900"
                            : "border-zinc-300 dark:border-white/20 text-transparent"
                        }`}
                      >
                        <Check className="h-3 w-3" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[12px] text-zinc-900 dark:text-white">
                          {option.label}
                        </div>
                        {option.description ? (
                          <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                            {option.description}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
              })}
              {question.allow_custom !== false ? (
                <div
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors focus-within:ring-2 focus-within:ring-zinc-300/50 dark:focus-within:ring-white/10 ${
                    hasCustomValue
                      ? "border-zinc-900/60 dark:border-white/40 bg-zinc-900/[0.03] dark:bg-white/10"
                      : "border-zinc-200/80 dark:border-white/10 bg-zinc-50/60 dark:bg-white/5"
                  }`}
                >
                  <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                    {question.custom_label || "Add details"}
                  </span>
                  <input
                    type="text"
                    value={customValue}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCustomAnswers((prev) => ({
                        ...prev,
                        [question.id]: value,
                      }));
                    }}
                    disabled={disabled}
                    placeholder={question.placeholder || "Type your answer"}
                    className="flex-1 bg-transparent text-[12px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none"
                  />
                </div>
              ) : null}
            </>
          ) : type === "boolean" ? (
            <div className="grid grid-cols-2 gap-1.5">
              {["Yes", "No"].map((label) => {
                const isSelected =
                  customValue.trim().toLowerCase() === label.toLowerCase();
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => updateCustomValue(question.id, label)}
                    disabled={disabled}
                    aria-pressed={isSelected}
                    className={`rounded-md border px-2.5 py-2 text-[12px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300/60 dark:focus-visible:ring-white/20 ${
                      isSelected
                        ? "border-zinc-900/80 dark:border-white bg-zinc-900/5 dark:bg-white/10 shadow-[0_1px_0_rgba(0,0,0,0.08)] text-zinc-900 dark:text-white"
                        : "border-zinc-200/80 dark:border-white/10 bg-white dark:bg-transparent hover:border-zinc-300/80 dark:hover:border-white/20 hover:bg-zinc-50 dark:hover:bg-white/5 text-zinc-800 dark:text-zinc-200"
                    } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : type === "textarea" ? (
            <textarea
              value={customValue}
              onChange={(event) => updateCustomValue(question.id, event.target.value)}
              rows={Math.max(2, Math.min(12, question.rows ?? 4))}
              placeholder={question.placeholder || "Type your answer"}
              disabled={disabled}
              className="w-full resize-none rounded-md border border-zinc-200/80 dark:border-white/10 bg-zinc-50/60 dark:bg-white/5 px-2.5 py-1.5 text-[12px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-300/50 dark:focus:ring-white/10"
            />
          ) : (
            <input
              type={type === "number" ? "number" : type === "date" ? "date" : "text"}
              value={customValue}
              onChange={(event) => updateCustomValue(question.id, event.target.value)}
              disabled={disabled}
              placeholder={question.placeholder || "Type your answer"}
              min={type === "number" ? question.min : undefined}
              max={type === "number" ? question.max : undefined}
              step={type === "number" ? question.step : undefined}
              className={`w-full rounded-md border px-2.5 py-1.5 text-[12px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-300/50 dark:focus:ring-white/10 ${
                hasCustomValue
                  ? "border-zinc-900/60 dark:border-white/40 bg-zinc-900/[0.03] dark:bg-white/10"
                  : "border-zinc-200/80 dark:border-white/10 bg-zinc-50/60 dark:bg-white/5"
              }`}
            />
          )}
        </div>
      </div>
    );
  };

  const currentIsAnswered = currentQuestion
    ? hasQuestionAnswer(currentQuestion.id, answers, customAnswers)
    : false;
  const currentIsRequired = currentQuestion ? currentQuestion.required !== false : false;
  const canAdvance = !currentIsRequired || currentIsAnswered;

  return (
    <div className="rounded-xl border border-default bg-secondary overflow-hidden">
      <div className="px-3 sm:px-4 py-3 border-b border-default bg-tertiary">
        <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
          Clarification
        </div>
        <div className="mt-1 text-[15px] font-semibold text-zinc-900 dark:text-white">
          {payload.title || "Clarify a few details"}
        </div>
        {payload.description ? (
          <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">
            {payload.description}
          </p>
        ) : null}
        {isStepper ? (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[10px] text-zinc-400 dark:text-zinc-500">
              <span>
                Step {clampedStepIndex + 1} of {totalSteps}
              </span>
              <span>{Math.round(((clampedStepIndex + 1) / totalSteps) * 100)}%</span>
            </div>
            <div className="mt-2 h-1 w-full rounded-full bg-zinc-200/70 dark:bg-white/10">
              <div
                className="h-full rounded-full bg-zinc-900 dark:bg-white transition-all shadow-[0_0_0_1px_rgba(0,0,0,0.02)]"
                style={{ width: `${((clampedStepIndex + 1) / totalSteps) * 100}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="px-3 sm:px-4 py-3 space-y-3">
        {isStepper ? (
          <>
            {currentQuestion ? renderQuestion(currentQuestion) : null}
            {isLastStep ? (
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
                  Add details (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={3}
                  placeholder="Add any extra context you want the agent to see."
                  disabled={disabled}
                  className="w-full resize-none rounded-md border border-zinc-200/80 dark:border-white/10 bg-zinc-50/60 dark:bg-white/5 px-2.5 py-1.5 text-[12px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-300/50 dark:focus:ring-white/10"
                />
              </div>
            ) : null}
          </>
        ) : (
          <>
            {payload.questions.map((question) => renderQuestion(question))}
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
                Add details (optional)
              </label>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                placeholder="Add any extra context you want the agent to see."
                disabled={disabled}
                className="w-full resize-none rounded-md border border-zinc-200/80 dark:border-white/10 bg-zinc-50/60 dark:bg-white/5 px-2.5 py-1.5 text-[12px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-300/50 dark:focus:ring-white/10"
              />
            </div>
          </>
        )}
      </div>

      <div className="px-3 sm:px-4 py-2 border-t border-zinc-200/70 dark:border-white/10 bg-zinc-50/70 dark:bg-white/5 flex flex-wrap items-center gap-2.5">
        {isStepper ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-full border border-zinc-200/80 dark:border-white/10 bg-white text-zinc-800 text-[11px] px-2.5 py-1 hover:bg-zinc-50 dark:bg-transparent dark:text-zinc-200 dark:hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => setStepIndex((prev) => Math.max(prev - 1, 0))}
              disabled={isFirstStep || disabled}
            >
              Back
            </button>
            {!isLastStep ? (
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full bg-zinc-900 text-white text-[11px] px-2.5 py-1 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                onClick={() =>
                  setStepIndex((prev) => Math.min(prev + 1, totalSteps - 1))
                }
                disabled={!canAdvance || disabled}
              >
                Next
              </button>
            ) : null}
          </div>
        ) : null}
        {onInsert && (!isStepper || isLastStep) ? (
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-full border border-zinc-200/80 dark:border-white/10 bg-white text-zinc-800 text-[11px] px-2.5 py-1 hover:bg-zinc-50 dark:bg-transparent dark:text-zinc-200 dark:hover:bg-white/5 transition-colors"
            onClick={() => onInsert(responseText)}
            disabled={!responseText.trim() || disabled}
          >
            Insert response
          </button>
        ) : null}
        {!isStepper || isLastStep ? (
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-full bg-zinc-900 text-white text-[12px] px-3 py-1.5 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
            onClick={handleSend}
            disabled={!canSend || disabled}
          >
            {payload.submit_label || "Send"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
