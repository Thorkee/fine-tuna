"use client";

import { Suspense, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Compass,
  Cpu,
  LineChart,
  Loader2,
  Sparkles,
  Wand2,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { sanitizeNextRedirect } from "@/lib/redirects";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/lib/store";
import type { ProjectMode } from "@/types";

type Goal = "train" | "analyze" | "compare" | "explore";

const stepVariants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction > 0 ? 24 : -24,
    filter: "blur(10px)",
  }),
  center: {
    opacity: 1,
    x: 0,
    filter: "blur(0px)",
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction > 0 ? -24 : 24,
    filter: "blur(10px)",
  }),
};

function parseGoal(value: unknown): Goal | null {
  if (value === "train" || value === "analyze" || value === "compare" || value === "explore") {
    return value;
  }
  return null;
}

function parseProjectMode(value: unknown): ProjectMode | null {
  if (value === "own_data" || value === "autonomous") {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePrefString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const EXPERIENCE_OPTIONS = [
  { id: "", label: "Select experience" },
  { id: "new", label: "New to AI" },
  { id: "some", label: "Some experience" },
  { id: "advanced", label: "Advanced" },
  { id: "expert", label: "Expert" },
];

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh w-full flex items-center justify-center bg-primary transition-colors duration-500 px-4">
          <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        </div>
      }
    >
      <OnboardingInner />
    </Suspense>
  );
}

function OnboardingInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);

  const persistMode = useProjectStore((s) => s.setMode);
  const storedMode = useProjectStore((s) => s.mode);

  const nextAfterOnboarding = sanitizeNextRedirect(searchParams.get("next"));
  const editParam = searchParams.get("edit");
  const isEditMode = editParam === "1" || editParam === "true";

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [userId, setUserId] = useState<string | null>(null);

  const [step, setStep] = useState(() => (isEditMode ? 1 : 0));
  const [direction, setDirection] = useState(1);

  const [fullName, setFullName] = useState("");
  const [nickname, setNickname] = useState("");
  const [occupation, setOccupation] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [industry, setIndustry] = useState("");
  const [experienceLevel, setExperienceLevel] = useState("");
  const [region, setRegion] = useState("");
  const [primaryUseCase, setPrimaryUseCase] = useState("");
  const [instructions, setInstructions] = useState("");
  const [commEmailUpdates, setCommEmailUpdates] = useState(true);
  const [commQueuedTasks, setCommQueuedTasks] = useState(true);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [mode, setMode] = useState<ProjectMode>(storedMode);
  const [basePreferences, setBasePreferences] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (isEditMode) {
      setStep((prev) => (prev === 0 ? 1 : prev));
    }
  }, [isEditMode]);

  useEffect(() => {
    setMode(storedMode);
  }, [storedMode]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setLoading(true);
      setError(null);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push(`/login?next=${encodeURIComponent("/onboarding")}`);
        return;
      }

      if (cancelled) return;
      setUserId(user.id);

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("full_name,onboarding_completed,preferences")
        .eq("id", user.id)
        .maybeSingle();

      if (cancelled) return;

      if (profileError) {
        // If DB migrations haven't been applied yet, don't hard-block onboarding UI.
        // Middleware will also fail open in that case.
        setLoading(false);
        return;
      }

      setFullName(profile?.full_name ?? "");
      const prefs = (profile?.preferences ?? {}) as Record<string, unknown>;
      setBasePreferences(prefs);
      setNickname(typeof prefs.nickname === "string" ? prefs.nickname : "");
      setOccupation(typeof prefs.occupation === "string" ? prefs.occupation : "");
      setRoleTitle(typeof prefs.role_title === "string" ? prefs.role_title : "");
      setCompanyName(typeof prefs.company === "string" ? prefs.company : "");
      setIndustry(typeof prefs.industry === "string" ? prefs.industry : "");
      setExperienceLevel(typeof prefs.experience_level === "string" ? prefs.experience_level : "");
      setRegion(typeof prefs.region === "string" ? prefs.region : "");
      setPrimaryUseCase(typeof prefs.primary_use_case === "string" ? prefs.primary_use_case : "");
      setInstructions(typeof prefs.instructions === "string" ? prefs.instructions : "");
      const commPrefs = isRecord(prefs.comm) ? prefs.comm : {};
      setCommEmailUpdates(
        typeof commPrefs.email_updates === "boolean" ? commPrefs.email_updates : true
      );
      setCommQueuedTasks(
        typeof commPrefs.queued_task_start === "boolean" ? commPrefs.queued_task_start : false
      );
      setGoal(parseGoal(prefs.goal));
      const prefMode = parseProjectMode(prefs.default_mode);
      if (prefMode) {
        persistMode(prefMode);
        setMode(prefMode);
      }
      if (profile?.onboarding_completed && !isEditMode) {
        router.push(nextAfterOnboarding);
        router.refresh();
        return;
      }

      setLoading(false);
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [router, supabase, nextAfterOnboarding, isEditMode, persistMode]);

  const goToStep = useCallback((nextStep: number) => {
    setDirection(nextStep > step ? 1 : -1);
    setStep(nextStep);
  }, [step]);

  const steps = [
    { label: "Welcome" },
    { label: "Profile" },
    { label: "Background" },
    { label: "Goal" },
    { label: "Mode" },
    { label: "Preferences" },
    { label: "Done" },
  ] as const;

  const lastStep = steps.length - 1;

  const canContinue =
    (step === 0 && true) ||
    (step === 1 && fullName.trim().length >= 2) ||
    (step === 2 && true) ||
    (step === 3 && goal !== null) ||
    (step === 4 && Boolean(mode)) ||
    (step === 5 && true);

  const handleNext = useCallback(() => {
    if (!canContinue) return;
    goToStep(Math.min(step + 1, lastStep));
  }, [canContinue, goToStep, lastStep, step]);

  const handleBack = useCallback(() => {
    goToStep(Math.max(step - 1, 0));
  }, [goToStep, step]);

  const finish = useCallback(async () => {
    if (!userId) return;
    setSubmitting(true);
    setError(null);

    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      id: userId,
      onboarding_completed: true,
      onboarding_completed_at: now,
    };

    if (fullName.trim()) payload.full_name = fullName.trim();
    payload.preferences = {
      ...basePreferences,
      nickname: normalizePrefString(nickname),
      occupation: normalizePrefString(occupation),
      instructions: normalizePrefString(instructions),
      role_title: normalizePrefString(roleTitle),
      company: normalizePrefString(companyName),
      industry: normalizePrefString(industry),
      experience_level: normalizePrefString(experienceLevel),
      region: normalizePrefString(region),
      primary_use_case: normalizePrefString(primaryUseCase),
      goal: goal ?? null,
      default_mode: mode,
      comm: {
        ...(isRecord(basePreferences.comm) ? basePreferences.comm : {}),
        email_updates: commEmailUpdates,
        queued_task_start: commQueuedTasks,
      },
    };

    const { error: upsertError } = await supabase
      .from("profiles")
      .upsert(payload, { onConflict: "id" });

    if (upsertError) {
      setError(upsertError.message);
      setSubmitting(false);
      return;
    }

    // Persist default mode for the console experience.
    persistMode(mode);

    router.push(nextAfterOnboarding);
    router.refresh();
  }, [
    basePreferences,
    companyName,
    commEmailUpdates,
    commQueuedTasks,
    experienceLevel,
    fullName,
    goal,
    instructions,
    industry,
    mode,
    nickname,
    nextAfterOnboarding,
    occupation,
    persistMode,
    primaryUseCase,
    region,
    roleTitle,
    router,
    supabase,
    userId,
  ]);

  return (
    <div className="relative min-h-dvh w-full bg-primary transition-colors duration-500">
      {/* Ambient background */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          aria-hidden
          className="absolute top-[-25%] left-[-15%] w-[680px] h-[680px] bg-purple-500/15 rounded-full blur-[130px]"
          animate={{ y: [0, 18, 0], x: [0, 10, 0], scale: [1, 1.03, 1] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          aria-hidden
          className="absolute bottom-[-25%] right-[-15%] w-[560px] h-[560px] bg-indigo-500/15 rounded-full blur-[130px]"
          animate={{ y: [0, -16, 0], x: [0, -12, 0], scale: [1, 1.04, 1] }}
          transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          aria-hidden
          className="absolute top-[20%] right-[10%] w-[240px] h-[240px] bg-fuchsia-500/10 rounded-full blur-[90px]"
          animate={{ y: [0, 14, 0], opacity: [0.55, 0.75, 0.55] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.08] dark:opacity-[0.06]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(0,0,0,0.25) 1px, transparent 0)",
            backgroundSize: "28px 28px",
          }}
        />
      </div>

      <div
        className={[
          "relative z-10 mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-4",
          "safe-area-py",
        ].join(" ")}
      >
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.19, 1, 0.22, 1] }}
          className="flex items-center justify-center py-4"
        >
          <Image
            src="/tuna.png"
            alt="tuna logo"
            width={216}
            height={117}
            className="brand-logo h-6 w-auto object-contain opacity-85"
            priority
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.19, 1, 0.22, 1] }}
          className="flex-1 flex items-start sm:items-center"
        >
          <div className="w-full rounded-3xl border border-default bg-[hsl(var(--bg-elevated)/0.85)] p-6 shadow-sm backdrop-blur-xl sm:p-10 overflow-hidden">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <span>{isEditMode ? "Profile" : "Setup"}</span>
            </div>
              <h1 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">
              {isEditMode ? "Update your profile." : "Let's get you ready."}
              </h1>
              <p className="mt-2 text-[15px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
              {isEditMode
                ? "Refresh your defaults and personalization in a few steps."
                : "A quick, guided setup—so the console feels instantly tailored to how you build."}
              </p>
            </div>

            {/* Progress */}
            <div className="shrink-0">
              <div className="flex items-center gap-2">
                {steps.map((s, idx) => {
                  const active = idx === step;
                  const done = idx < step;
                  return (
                    <motion.div
                      key={s.label}
                      className={cn(
                        "relative w-3 h-3 rounded-full",
                        done
                          ? "bg-zinc-900 dark:bg-white"
                          : active
                            ? "bg-zinc-900/30 dark:bg-white/25"
                            : "bg-zinc-200 dark:bg-white/10"
                      )}
                      animate={
                        active
                          ? { scale: [1, 1.18, 1] }
                          : done
                            ? { scale: 1 }
                            : { scale: 1 }
                      }
                      transition={{ duration: 0.6, ease: [0.19, 1, 0.22, 1] }}
                      title={s.label}
                      aria-label={s.label}
                    >
                      {active && (
                        <motion.div
                          aria-hidden
                          className="absolute inset-[-6px] rounded-full border border-zinc-900/10 dark:border-white/10"
                          animate={{ opacity: [0.35, 0.75, 0.35], scale: [1, 1.06, 1] }}
                          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                        />
                      )}
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="mt-8">
            {loading ? (
              <div className="flex items-center justify-center py-14 text-zinc-500 dark:text-zinc-400">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="ml-2 text-sm">Preparing your setup…</span>
              </div>
            ) : (
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={step}
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.28, ease: [0.19, 1, 0.22, 1] }}
                >
                  {/* Step 0: Welcome */}
                  {step === 0 && (
                    <div className="space-y-5">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <FeatureCard
                          icon={<Wand2 className="w-5 h-5" />}
                          title="Agentic workflows"
                          desc="From intent to data, training, and deployment workflows."
                        />
                        <FeatureCard
                          icon={<Cpu className="w-5 h-5" />}
                          title="Compute choices"
                          desc="Compare providers, clusters, and GPUs when needed."
                        />
                        <FeatureCard
                          icon={<LineChart className="w-5 h-5" />}
                          title="Artifacts built-in"
                          desc="Plans, curation, analysis, scripts, and exports."
                        />
                      </div>

                      <div className="rounded-2xl border border-default bg-[hsl(var(--bg-elevated)/0.75)] p-4">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 flex items-center justify-center shrink-0">
                            <Compass className="w-5 h-5" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-900 dark:text-white">
                              {isEditMode ? "Quick refresh." : "Two minutes. Zero fluff."}
                            </div>
                            <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                              {isEditMode
                                ? "Update your profile and defaults anytime."
                                : "We'll capture just enough to personalize the console. You can change these later."}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Step 1: Profile */}
                  {step === 1 && (
                    <div className="space-y-4">
                      <div>
                        <div className="text-sm font-medium text-zinc-900 dark:text-white">
                          What should we call you?
                        </div>
                        <div className="mt-2">
                          <input
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            placeholder="Full name"
                            className={cn(
                              "w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                              fullName.trim().length > 0 && fullName.trim().length < 2
                                ? "border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500"
                                : "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                            )}
                            autoFocus
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="text-xs text-zinc-500 dark:text-zinc-400">Nickname</label>
                          <input
                            value={nickname}
                            onChange={(e) => setNickname(e.target.value)}
                            placeholder="What should we call you?"
                            className={cn(
                              "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                              "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                            )}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-zinc-500 dark:text-zinc-400">Occupation</label>
                          <input
                            value={occupation}
                            onChange={(e) => setOccupation(e.target.value)}
                            placeholder="e.g., Product Designer"
                            className={cn(
                              "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                              "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                            )}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Step 2: Background */}
                  {step === 2 && (
                    <div className="space-y-4">
                      <div className="text-sm font-medium text-zinc-900 dark:text-white">
                        Tell us a bit about your work.
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="text-xs text-zinc-500 dark:text-zinc-400">Role / title</label>
                          <input
                            value={roleTitle}
                            onChange={(e) => setRoleTitle(e.target.value)}
                            placeholder="e.g., ML Engineer"
                            className={cn(
                              "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                              "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                            )}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-zinc-500 dark:text-zinc-400">Company</label>
                          <input
                            value={companyName}
                            onChange={(e) => setCompanyName(e.target.value)}
                            placeholder="Company name"
                            className={cn(
                              "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                              "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                            )}
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="text-xs text-zinc-500 dark:text-zinc-400">Industry</label>
                          <input
                            value={industry}
                            onChange={(e) => setIndustry(e.target.value)}
                            placeholder="e.g., Fintech"
                            className={cn(
                              "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                              "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                            )}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-zinc-500 dark:text-zinc-400">Experience level</label>
                          <select
                            value={experienceLevel}
                            onChange={(e) => setExperienceLevel(e.target.value)}
                            className={cn(
                              "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white",
                              "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                            )}
                          >
                            {EXPERIENCE_OPTIONS.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 dark:text-zinc-400">Region / timezone</label>
                        <input
                          value={region}
                          onChange={(e) => setRegion(e.target.value)}
                          placeholder="e.g., North America, GMT-5"
                          className={cn(
                            "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                            "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                          )}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 dark:text-zinc-400">Primary use case</label>
                        <textarea
                          value={primaryUseCase}
                          onChange={(e) => setPrimaryUseCase(e.target.value)}
                          placeholder="What are you aiming to build or ship first?"
                          rows={3}
                          className={cn(
                            "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                            "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                          )}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-500 dark:text-zinc-400">Custom instructions</label>
                        <textarea
                          value={instructions}
                          onChange={(e) => setInstructions(e.target.value)}
                          placeholder="How should Tuna respond?"
                          rows={3}
                          className={cn(
                            "mt-1 w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500",
                            "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                          )}
                        />
                      </div>
                    </div>
                  )}

                  {/* Step 3: Goal */}
                  {step === 3 && (
                    <div className="space-y-4">
                      <div className="text-sm font-medium text-zinc-900 dark:text-white">
                        What are you here to do first?
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <ChoiceCard
                          selected={goal === "train"}
                          onClick={() => setGoal("train")}
                          title="Train & fine-tune"
                          desc="End-to-end training with scripts, compute, and exports."
                          icon={<Cpu className="w-5 h-5" />}
                        />
                        <ChoiceCard
                          selected={goal === "analyze"}
                          onClick={() => setGoal("analyze")}
                          title="Analyze data"
                          desc="EDA and preprocessing insights to prepare training."
                          icon={<LineChart className="w-5 h-5" />}
                        />
                        <ChoiceCard
                          selected={goal === "compare"}
                          onClick={() => setGoal("compare")}
                          title="Compare providers"
                          desc="Pick the best provider, GPU, or cluster setup."
                          icon={<Compass className="w-5 h-5" />}
                        />
                        <ChoiceCard
                          selected={goal === "explore"}
                          onClick={() => setGoal("explore")}
                          title="Just exploring"
                          desc="See the full vibe-tuning workflow."
                          icon={<Sparkles className="w-5 h-5" />}
                        />
                      </div>
                    </div>
                  )}

                  {/* Step 4: Mode */}
                  {step === 4 && (
                    <div className="space-y-4">
                      <div className="text-sm font-medium text-zinc-900 dark:text-white">
                        How should the agent operate by default?
                      </div>
                      <div className="grid grid-cols-1 gap-3">
                        <ChoiceCard
                          selected={mode === "own_data"}
                          onClick={() => setMode("own_data")}
                          title="Own Data"
                          desc="Bring your dataset—get a guided pipeline and artifacts."
                          icon={<LineChart className="w-5 h-5" />}
                        />
                        <ChoiceCard
                          selected={mode === "autonomous"}
                          onClick={() => setMode("autonomous")}
                          title="Autonomous"
                          desc="The agent drives research + orchestration end-to-end."
                          icon={<Wand2 className="w-5 h-5" />}
                        />
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        This just sets your default. You can switch modes any time.
                      </div>
                    </div>
                  )}

                  {/* Step 5: Preferences */}
                  {step === 5 && (
                    <div className="space-y-4">
                      <div className="text-sm font-medium text-zinc-900 dark:text-white">
                        Communication preferences
                      </div>
                      <div className="space-y-3 text-sm">
                        <label className="flex items-center justify-between gap-4">
                          <div>
                            <div className="font-medium text-zinc-900 dark:text-white">Receive exclusive content</div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">
                              Get updates, guides, and new feature notes.
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setCommEmailUpdates((prev) => !prev)}
                            className={cn(
                              "h-5 w-9 rounded-full transition-colors",
                              commEmailUpdates ? "bg-emerald-500" : "bg-zinc-200 dark:bg-white/10"
                            )}
                          >
                            <span
                              className={cn(
                                "block h-4 w-4 rounded-full bg-white transition-transform",
                                commEmailUpdates ? "translate-x-4" : "translate-x-1"
                              )}
                            />
                          </button>
                        </label>

                        <label className="flex items-center justify-between gap-4">
                          <div>
                            <div className="font-medium text-zinc-900 dark:text-white">Email when queued tasks start</div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">
                              We’ll let you know when processing begins.
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setCommQueuedTasks((prev) => !prev)}
                            className={cn(
                              "h-5 w-9 rounded-full transition-colors",
                              commQueuedTasks ? "bg-emerald-500" : "bg-zinc-200 dark:bg-white/10"
                            )}
                          >
                            <span
                              className={cn(
                                "block h-4 w-4 rounded-full bg-white transition-transform",
                                commQueuedTasks ? "translate-x-4" : "translate-x-1"
                              )}
                            />
                          </button>
                        </label>
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        You can update these anytime in Settings.
                      </div>
                    </div>
                  )}

                  {/* Step 6: Done */}
                  {step === lastStep && (
                    <div className="space-y-5">
                      <div className="rounded-2xl border border-default bg-[hsl(var(--bg-elevated)/0.75)] p-5">
                        <div className="flex items-start gap-3">
                          <motion.div
                            className="w-11 h-11 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0"
                            animate={{ scale: [1, 1.04, 1] }}
                            transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                          >
                            <CheckCircle2 className="w-6 h-6" />
                          </motion.div>
                          <div className="min-w-0">
                            <div className="text-base font-semibold text-zinc-900 dark:text-white">
                              {isEditMode ? "Profile updated." : "You're all set."}
                            </div>
                            <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                              {isEditMode
                                ? "Your default mode is set to "
                                : "We'll drop you into the console with your default mode set to "}
                              <span className="font-medium text-zinc-900 dark:text-white">
                                {mode === "autonomous" ? "Autonomous" : "Own Data"}
                              </span>
                              .
                            </div>
                          </div>
                        </div>
                      </div>

                      {error && (
                        <div className="text-sm text-red-500 font-medium animate-in fade-in slide-in-from-top-1">
                          {error}
                        </div>
                      )}

                      <button
                        onClick={finish}
                        disabled={submitting}
                        className={cn(
                          "w-full bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-medium py-3.5 rounded-full transition-all duration-200 flex items-center justify-center gap-2 text-[15px] shadow-lg shadow-zinc-500/20 dark:shadow-none",
                          submitting && "opacity-80 cursor-not-allowed"
                        )}
                      >
                        {submitting ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span>Finalizing…</span>
                          </>
                        ) : (
                          <>
                            <span>{isEditMode ? "Save changes" : "Enter console"}</span>
                            <ArrowRight className="w-4 h-4" />
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {/* Footer actions */}
          {!loading && (
            <div className="mt-8 flex items-center justify-between gap-3">
              <button
                onClick={handleBack}
                disabled={step === 0 || submitting}
                className={cn(
                  "inline-flex items-center gap-2 px-3 py-2 rounded-full text-sm transition-colors",
                  step === 0 || submitting
                    ? "text-zinc-400 cursor-not-allowed"
                    : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-white/5"
                )}
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>

              {step < lastStep && (
                <button
                  onClick={handleNext}
                  disabled={!canContinue || submitting}
                  className={cn(
                    "inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium transition-all",
                    canContinue && !submitting
                      ? "bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-200 text-white dark:text-zinc-900 shadow-md"
                      : "bg-zinc-200 dark:bg-white/10 text-zinc-400 dark:text-zinc-500 cursor-not-allowed"
                  )}
                >
                  Continue
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
          </div>
        </motion.div>

        {/* Subtle bottom caption */}
        {!loading && step < lastStep && (
          <div className="mt-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
            {isEditMode
              ? "Update your preferences anytime from your profile."
              : "Mandatory setup for new accounts. Takes ~2 minutes."}
          </div>
        )}
      </div>
    </div>
  );
}

function FeatureCard(props: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-default bg-[hsl(var(--bg-elevated)/0.75)] p-4 overflow-hidden min-h-[110px] max-h-[110px]">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-tertiary border border-default flex items-center justify-center text-secondary shrink-0">
          {props.icon}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-900 dark:text-white line-clamp-1">{props.title}</div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed line-clamp-2">
            {props.desc}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChoiceCard(props: {
  selected: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  icon: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={props.onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.985 }}
      className={cn(
        "text-left w-full rounded-2xl border p-4 transition-all duration-200 overflow-hidden min-h-[120px] max-h-[120px]",
        "bg-[hsl(var(--bg-elevated)/0.75)]",
        props.selected
          ? "border-[hsl(var(--accent-violet))] shadow-[0_0_0_4px_hsl(var(--accent-violet)/0.12)]"
          : "border-default hover:border-[hsl(var(--border-hover))]"
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center border shrink-0 transition-colors",
            props.selected
              ? "bg-[hsl(var(--accent-violet))] text-white border-[hsl(var(--accent-violet))]"
              : "bg-tertiary text-secondary border-default"
          )}
        >
          {props.icon}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-900 dark:text-white line-clamp-1">{props.title}</div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed line-clamp-2">
            {props.desc}
          </div>
        </div>
      </div>
    </motion.button>
  );
}

