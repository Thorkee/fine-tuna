import type { ProjectContext, ProjectMode } from "@/types";

export const DEFAULT_PROJECT_MODE: ProjectMode = "own_data";

const EXPERIENCE_LABELS: Record<string, string> = {
  new: "New to AI",
  some: "Some experience",
  advanced: "Advanced",
  expert: "Expert",
};

const GOAL_LABELS: Record<string, string> = {
  train: "Train & fine-tune",
  analyze: "Analyze data",
  compare: "Compare providers",
  explore: "Just exploring",
};

type ProfileRow = {
  full_name?: string | null;
  preferences?: Record<string, unknown> | null;
};

type CommPreferences = {
  emailUpdates?: boolean;
  queuedTaskStart?: boolean;
  queuedTaskStartLastSentAt?: string | null;
};

export type ParsedProfileContext = {
  prefs: Record<string, unknown>;
  preferredMode: ProjectMode | null;
  skillPreferences?: ProjectContext["skillPreferences"];
  comm: CommPreferences;
  userProfile?: ProjectContext["userProfile"];
};

export function parseProjectMode(value: unknown): ProjectMode | null {
  if (value === "own_data" || value === "autonomous") {
    return value;
  }
  return null;
}

export function resolvePreferredMode(
  preferredMode: ProjectMode | null | undefined,
  fallback: ProjectMode = DEFAULT_PROJECT_MODE
): ProjectMode {
  return preferredMode ?? fallback;
}

function readPrefString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readPrefBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function readSkillPreferences(prefs: Record<string, unknown>): ProjectContext["skillPreferences"] | undefined {
  const rawSkills =
    typeof prefs.skills === "object" && prefs.skills !== null
      ? (prefs.skills as Record<string, unknown>)
      : null;
  if (!rawSkills) return undefined;
  const rawHf =
    typeof rawSkills.huggingface === "object" && rawSkills.huggingface !== null
      ? (rawSkills.huggingface as Record<string, unknown>)
      : {};
  const huggingface = {
    search_hub: readPrefBool(rawHf.search_hub),
    explore_datasets: readPrefBool(rawHf.explore_datasets),
    query_dataset: readPrefBool(rawHf.query_dataset),
    get_documentation: readPrefBool(rawHf.get_documentation),
    run_spaces: readPrefBool(rawHf.run_spaces),
    train_model: readPrefBool(rawHf.train_model),
  };
  const hasAny = Object.values(huggingface).some((value) => typeof value === "boolean");
  if (!hasAny) return undefined;
  return { huggingface };
}

function mapWithLabels(value: unknown, labels: Record<string, string>): string | null {
  const raw = readPrefString(value);
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return labels[normalized] ?? raw;
}

export function parseProfileContext(profile: ProfileRow): ParsedProfileContext {
  const prefs = (profile?.preferences ?? {}) as Record<string, unknown>;
  const preferredMode = parseProjectMode(prefs.default_mode);
  const skillPreferences = readSkillPreferences(prefs);
  const commPrefs =
    typeof prefs.comm === "object" && prefs.comm !== null
      ? (prefs.comm as Record<string, unknown>)
      : {};
  const queuedTaskStartLastSentAtRaw =
    typeof commPrefs.queued_task_start_last_sent_at === "string"
      ? commPrefs.queued_task_start_last_sent_at.trim()
      : "";

  const userProfile: ProjectContext["userProfile"] = {
    fullName: readPrefString(profile?.full_name),
    nickname: readPrefString(prefs.nickname),
    roleTitle: readPrefString(prefs.role_title),
    company: readPrefString(prefs.company),
    industry: readPrefString(prefs.industry),
    experienceLevel: mapWithLabels(prefs.experience_level, EXPERIENCE_LABELS),
    region: readPrefString(prefs.region),
    primaryUseCase: readPrefString(prefs.primary_use_case),
    occupation: readPrefString(prefs.occupation),
    about: readPrefString(prefs.about),
    instructions: readPrefString(prefs.instructions),
    goal: mapWithLabels(prefs.goal, GOAL_LABELS),
  };
  const hasProfile = Object.values(userProfile).some((value) => Boolean(value));

  return {
    prefs,
    preferredMode,
    skillPreferences,
    comm: {
      emailUpdates: readPrefBool(commPrefs.email_updates),
      queuedTaskStart: readPrefBool(commPrefs.queued_task_start),
      queuedTaskStartLastSentAt: queuedTaskStartLastSentAtRaw || null,
    },
    userProfile: hasProfile ? userProfile : undefined,
  };
}
