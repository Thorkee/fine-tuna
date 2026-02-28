"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { sanitizeNextRedirect } from "@/lib/redirects";
import { useProjectStore } from "@/lib/store";
import type { ProjectMode } from "@/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProjectMode(value: unknown): ProjectMode | null {
  if (value === "own_data" || value === "autonomous") return value;
  return null;
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh w-full flex items-center justify-center bg-primary">
          <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading setup...</span>
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
  const isEditMode = searchParams.get("edit") === "1" || searchParams.get("edit") === "true";

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [step, setStep] = useState(() => (isEditMode ? 1 : 0));
  const [fullName, setFullName] = useState("");
  const [mode, setMode] = useState<ProjectMode>(storedMode);
  const [commEmailUpdates, setCommEmailUpdates] = useState(true);
  const [commQueuedTasks, setCommQueuedTasks] = useState(false);
  const [basePreferences, setBasePreferences] = useState<Record<string, unknown>>({});

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

      // Fail open when migrations are not applied yet.
      if (!profileError) {
        setFullName(profile?.full_name ?? "");
        const prefs = (profile?.preferences ?? {}) as Record<string, unknown>;
        setBasePreferences(prefs);
        const prefMode = parseProjectMode(prefs.default_mode);
        if (prefMode) {
          setMode(prefMode);
          persistMode(prefMode);
        }

        const commPrefs = isRecord(prefs.comm) ? prefs.comm : {};
        setCommEmailUpdates(
          typeof commPrefs.email_updates === "boolean" ? commPrefs.email_updates : true
        );
        setCommQueuedTasks(
          typeof commPrefs.queued_task_start === "boolean" ? commPrefs.queued_task_start : false
        );

        if (profile?.onboarding_completed && !isEditMode) {
          router.push(nextAfterOnboarding);
          router.refresh();
          return;
        }
      }

      setLoading(false);
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [isEditMode, nextAfterOnboarding, persistMode, router, supabase]);

  const steps = [
    { key: "welcome", label: "Welcome" },
    { key: "identity", label: "Identity" },
    { key: "mode", label: "Mode" },
    { key: "notifications", label: "Notifications" },
    { key: "done", label: "Done" },
  ] as const;

  const lastStep = steps.length - 1;
  const canContinue =
    (step === 0 && true) ||
    (step === 1 && fullName.trim().length >= 2) ||
    (step === 2 && Boolean(mode)) ||
    (step === 3 && true);

  const goNext = useCallback(() => {
    if (!canContinue) return;
    setStep((prev) => Math.min(prev + 1, lastStep));
  }, [canContinue, lastStep]);

  const goBack = useCallback(() => {
    setStep((prev) => Math.max(prev - 1, 0));
  }, []);

  const finish = useCallback(async () => {
    if (!userId) return;
    setSubmitting(true);
    setError(null);

    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      id: userId,
      onboarding_completed: true,
      onboarding_completed_at: now,
      preferences: {
        ...basePreferences,
        default_mode: mode,
        comm: {
          ...(isRecord(basePreferences.comm) ? basePreferences.comm : {}),
          email_updates: commEmailUpdates,
          queued_task_start: commQueuedTasks,
        },
      },
    };

    if (fullName.trim()) payload.full_name = fullName.trim();

    const { error: upsertError } = await supabase.from("profiles").upsert(payload, {
      onConflict: "id",
    });

    if (upsertError) {
      setSubmitting(false);
      setError(upsertError.message);
      return;
    }

    persistMode(mode);
    router.push(nextAfterOnboarding);
    router.refresh();
  }, [
    basePreferences,
    commEmailUpdates,
    commQueuedTasks,
    fullName,
    mode,
    nextAfterOnboarding,
    persistMode,
    router,
    supabase,
    userId,
  ]);

  return (
    <div className="relative min-h-dvh w-full bg-primary transition-colors duration-300">
      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[520px] flex-col px-4 safe-area-py">
        <div className="flex items-center justify-center py-4">
          <Image
            src="/tuna.png"
            alt="Tuna logo"
            width={220}
            height={124}
            className="h-14 w-auto object-contain opacity-90"
            priority
          />
        </div>

        <div className="flex-1 flex items-start sm:items-center">
          <div className="w-full rounded-3xl border border-default bg-[hsl(var(--bg-elevated)/0.9)] p-6 shadow-sm sm:p-8">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {isEditMode ? "Profile update" : "Onboarding"}
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                  {isEditMode ? "Update your setup" : "Set up Tuna"}
                </h1>
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {Math.min(step + 1, steps.length)} / {steps.length}
              </div>
            </div>

            <div className="mt-6">
              {loading ? (
                <div className="flex items-center justify-center py-10 text-zinc-500 dark:text-zinc-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="ml-2 text-sm">Preparing setup...</span>
                </div>
              ) : (
                <div className="space-y-4">
                  {step === 0 ? (
                    <div className="space-y-3">
                      <p className="text-sm text-zinc-600 dark:text-zinc-300">
                        This is a short setup to personalize your default workflow.
                      </p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        You can change everything later in Settings.
                      </p>
                    </div>
                  ) : null}

                  {step === 1 ? (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-zinc-900 dark:text-white">
                        Full name
                      </label>
                      <input
                        autoFocus
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="Your name"
                        className={cnInput(fullName.trim().length > 0 && fullName.trim().length < 2)}
                      />
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        This helps personalize responses.
                      </p>
                    </div>
                  ) : null}

                  {step === 2 ? (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">
                        Default mode
                      </p>
                      <ModeCard
                        selected={mode === "own_data"}
                        title="Own Data"
                        description="Bring your dataset and build with guided steps."
                        onClick={() => setMode("own_data")}
                      />
                      <ModeCard
                        selected={mode === "autonomous"}
                        title="Autonomous"
                        description="Let the agent drive planning and execution."
                        onClick={() => setMode("autonomous")}
                      />
                    </div>
                  ) : null}

                  {step === 3 ? (
                    <div className="space-y-4">
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">
                        Communication
                      </p>
                      <ToggleRow
                        label="Email updates"
                        description="Receive product and release updates."
                        enabled={commEmailUpdates}
                        onToggle={() => setCommEmailUpdates((prev) => !prev)}
                      />
                      <ToggleRow
                        label="Queued task start emails"
                        description="Get notified when queued processing starts."
                        enabled={commQueuedTasks}
                        onToggle={() => setCommQueuedTasks((prev) => !prev)}
                      />
                    </div>
                  ) : null}

                  {step === lastStep ? (
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-default bg-[hsl(var(--bg-elevated)/0.8)] p-4">
                        <div className="flex items-start gap-3">
                          <div className="h-10 w-10 rounded-full bg-emerald-500/15 text-emerald-500 flex items-center justify-center">
                            <CheckCircle2 className="h-5 w-5" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                              {isEditMode ? "Profile updated" : "Setup complete"}
                            </p>
                            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              Default mode:{" "}
                              <span className="font-medium text-zinc-700 dark:text-zinc-200">
                                {mode === "autonomous" ? "Autonomous" : "Own Data"}
                              </span>
                            </p>
                          </div>
                        </div>
                      </div>

                      {error ? <p className="text-sm text-red-500">{error}</p> : null}

                      <button
                        type="button"
                        onClick={finish}
                        disabled={submitting}
                        className="w-full bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-medium py-3 rounded-full transition-colors flex items-center justify-center gap-2 disabled:opacity-70"
                      >
                        {submitting ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            {isEditMode ? "Save changes" : "Enter console"}
                            <ArrowRight className="h-4 w-4" />
                          </>
                        )}
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {!loading && step < lastStep ? (
              <div className="mt-8 flex items-center justify-between">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={step === 0}
                  className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-white/5 disabled:opacity-40"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canContinue}
                  className="inline-flex items-center gap-1 rounded-full px-4 py-2 text-sm font-medium bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-200 text-white dark:text-zinc-900 disabled:opacity-40"
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeCard(props: {
  selected: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={[
        "w-full rounded-2xl border p-4 text-left transition-colors",
        props.selected
          ? "border-[hsl(var(--accent-violet))] bg-[hsl(var(--accent-violet)/0.08)]"
          : "border-default bg-[hsl(var(--bg-elevated)/0.6)] hover:border-[hsl(var(--border-hover))]",
      ].join(" ")}
    >
      <p className="text-sm font-semibold text-zinc-900 dark:text-white">{props.title}</p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{props.description}</p>
    </button>
  );
}

function ToggleRow(props: {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-white">{props.label}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{props.description}</p>
      </div>
      <button
        type="button"
        onClick={props.onToggle}
        className={[
          "h-5 w-9 rounded-full transition-colors",
          props.enabled ? "bg-emerald-500" : "bg-zinc-200 dark:bg-white/10",
        ].join(" ")}
      >
        <span
          className={[
            "block h-4 w-4 rounded-full bg-white transition-transform",
            props.enabled ? "translate-x-4" : "translate-x-1",
          ].join(" ")}
        />
      </button>
    </label>
  );
}

function cnInput(invalid: boolean): string {
  return [
    "mt-1 w-full rounded-2xl border px-4 py-3 text-sm outline-none transition-colors",
    "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white placeholder:text-zinc-500",
    invalid
      ? "border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500"
      : "border-zinc-300/80 dark:border-zinc-700 focus:border-zinc-900 dark:focus:border-white/20",
  ].join(" ");
}
