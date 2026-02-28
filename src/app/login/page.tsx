"use client";

import { Suspense, useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { sanitizeNextRedirect } from "@/lib/redirects";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2 } from "lucide-react";
import Image from "next/image";

function LoginPageInner() {
    const [email, setEmail] = useState("");
    const [otp, setOtp] = useState("");
    const [step, setStep] = useState<"email" | "otp">("email");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resendTimer, setResendTimer] = useState(60);

    const router = useRouter();
    const searchParams = useSearchParams();
    const supabase = useMemo(() => createClient(), []);

    const nextAfterLogin = useMemo(
        () => sanitizeNextRedirect(searchParams.get("next")),
        [searchParams]
    );

    // If Supabase redirects back to /login with an OAuth code (misconfigured redirect URL),
    // bounce to the server callback route to exchange it for a session.
    useEffect(() => {
        const code = searchParams.get("code");
        if (!code) return;
        const safeNext = nextAfterLogin;
        const target = `/auth/callback?code=${encodeURIComponent(code)}&next=${encodeURIComponent(safeNext)}`;
        window.location.replace(target);
    }, [nextAfterLogin, searchParams]);

    // Timer Effect
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (step === "otp" && resendTimer > 0) {
            interval = setInterval(() => {
                setResendTimer((prev) => prev - 1);
            }, 1000);
        }
        return () => clearInterval(interval);
    }, [step, resendTimer]);

    const handleVerifyOtp = useCallback(async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        setLoading(true);
        setError(null);

        const { error } = await supabase.auth.verifyOtp({
            email,
            token: otp,
            type: "email",
        });

        if (error) {
            setError(error.message);
            setLoading(false);
            setOtp(""); // Clear OTP on error so user can retype
        } else {
            await fetch("/api/account/welcome", { method: "POST" }).catch(() => {});
            router.push(nextAfterLogin);
            router.refresh();
        }
    }, [email, otp, nextAfterLogin, router, supabase]);

    // Auto-submit effect for OTP
    useEffect(() => {
        if (otp.length !== 8) return;
        const timeout = setTimeout(() => {
            handleVerifyOtp();
        }, 0);
        return () => clearTimeout(timeout);
    }, [otp, handleVerifyOtp]);

    const handleEmailLogin = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!email.trim()) {
            setError("Please enter your email address");
            return;
        }

        setLoading(true);
        setError(null);

        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: true },
        });

        if (error) {
            setError(error.message);
        } else {
            setOtp(""); // Ensure OTP is clear when switching steps
            setStep("otp");
        }
        setLoading(false);
    };

    const handleGoogleLogin = async () => {
        setLoading(true);
        const { error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
                redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextAfterLogin)}`,
            },
        });

        if (error) {
            setError(error.message);
            setLoading(false);
        }
    };

    const handleResendOtp = async () => {
        if (resendTimer > 0) return;

        setLoading(true);
        setError(null);

        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: true },
        });

        if (error) {
            setError(error.message);
        } else {
            setResendTimer(60); // Reset timer
        }
        setLoading(false);
    };

    return (
        <div className="relative min-h-dvh w-full bg-primary transition-colors duration-500">

            {/* Background Ambience */}
            <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-purple-500/10 rounded-full blur-[120px]" />
                <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-indigo-500/10 rounded-full blur-[120px]" />
            </div>

            <div
                className={[
                    "relative z-10 mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-4",
                    // Safe-area padding + a little breathing room on mobile.
                    "safe-area-py",
                ].join(" ")}
            >
                {/* Logo */}
                <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                    className="flex items-center justify-center py-4"
                >
                    <Image
                        src="/tuna.png"
                        alt="tuna logo"
                        width={220}
                        height={124}
                        className="h-14 w-auto object-contain opacity-85"
                        priority
                    />
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.55, ease: "easeOut" }}
                    className="flex-1 flex items-start sm:items-center"
                >
                    {/* Card */}
                    <div className="w-full rounded-3xl border border-default bg-[hsl(var(--bg-elevated)/0.85)] p-6 shadow-sm backdrop-blur-xl sm:p-8">

                        <h1 className="text-2xl sm:text-3xl font-semibold text-center mb-2 text-zinc-900 dark:text-white tracking-tight">
                            {step === "email" ? "Welcome to Tuna" : "Enter code"}
                        </h1>
                        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
                            {step === "email"
                                ? "Sign in to continue. New accounts complete a short setup."
                                : "Enter the 8‑digit code from your email."}
                        </p>

                        <div className="mt-7">
                            <AnimatePresence mode="wait">
                                {step === "email" ? (
                                    <motion.div
                                        key="email-step"
                                        initial={{ opacity: 0, x: -10 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: 10 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        <form onSubmit={handleEmailLogin} className="space-y-4">
                                            <div className="space-y-2">
                                                <input
                                                    id="email"
                                                    type="email"
                                                    inputMode="email"
                                                    autoComplete="email"
                                                    placeholder="Email address"
                                                    value={email}
                                                    onChange={(e) => {
                                                        setEmail(e.target.value);
                                                        if (error) setError(null);
                                                    }}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter") {
                                                            e.preventDefault();
                                                            handleEmailLogin(e);
                                                        }
                                                    }}
                                                    className={`w-full px-5 py-3.5 rounded-2xl bg-white dark:bg-zinc-900 border transition-all outline-none text-zinc-900 dark:text-white placeholder:text-zinc-500 ${error
                                                        ? "border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500"
                                                        : "border-zinc-300/80 dark:border-zinc-700 focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 dark:focus:ring-white/20 dark:focus:border-white/20"
                                                        }`}
                                                />
                                                {error && (
                                                    <p className="text-sm text-red-500 pl-2 font-medium animate-in fade-in slide-in-from-top-1">
                                                        {error}
                                                    </p>
                                                )}
                                            </div>

                                            <button
                                                type="submit"
                                                disabled={loading}
                                                className="w-full bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-200 text-white dark:text-zinc-900 font-medium py-3.5 rounded-full transition-all duration-200 flex items-center justify-center gap-2 group text-[15px] shadow-lg shadow-zinc-500/20 dark:shadow-none active:scale-[0.99]"
                                            >
                                                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <>Continue</>}
                                            </button>
                                        </form>

                                        <div className="relative my-6">
                                            <div className="absolute inset-0 flex items-center">
                                                <span className="w-full border-t border-zinc-200/80 dark:border-zinc-800" />
                                            </div>
                                            <div className="relative flex justify-center text-xs uppercase">
                                                <span className="bg-[hsl(var(--bg-primary))] px-2 text-zinc-500">
                                                    OR
                                                </span>
                                            </div>
                                        </div>

                                        <button
                                            onClick={handleGoogleLogin}
                                            disabled={loading}
                                            className="w-full flex items-center justify-center gap-3 bg-white dark:bg-zinc-900 border border-zinc-300/80 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 font-medium py-3.5 px-4 rounded-full transition-all duration-200 text-[15px] active:scale-[0.99]"
                                        >
                                            <svg className="w-5 h-5" viewBox="0 0 24 24">
                                                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                                                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                                                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                                                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                                            </svg>
                                            <span>Continue with Google</span>
                                        </button>
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key="otp-step"
                                        initial={{ opacity: 0, x: 20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: -20 }}
                                        transition={{ duration: 0.3 }}
                                    >
                                        <div className="mb-6 text-center">
                                            <p className="text-zinc-500 text-[15px]">
                                                We sent a code to{" "}
                                                <span className="text-zinc-900 dark:text-white font-semibold break-all">
                                                    {email}
                                                </span>
                                            </p>
                                        </div>

                                        <form onSubmit={handleVerifyOtp} className="space-y-6">
                                            <div className="relative flex justify-center w-full">
                                                <div className="flex gap-1 sm:gap-1.5">
                                                    {Array.from({ length: 8 }).map((_, i) => (
                                                        <div
                                                            key={i}
                                                            className={`w-8 h-10 sm:w-9 sm:h-11 rounded-lg border flex items-center justify-center text-[17px] font-mono font-semibold bg-white dark:bg-zinc-900 transition-all duration-200 ${otp[i]
                                                                ? "border-zinc-900 dark:border-white text-zinc-900 dark:text-white shadow-sm"
                                                                : "border-zinc-200 dark:border-zinc-700 text-zinc-400"
                                                                } ${i === otp.length && !loading ? "ring-2 ring-zinc-900/10 dark:ring-white/10 border-zinc-900 dark:border-white" : ""
                                                                }`}
                                                        >
                                                            {otp[i]}
                                                        </div>
                                                    ))}
                                                </div>
                                                <input
                                                    autoFocus
                                                    id="otp"
                                                    type="text"
                                                    inputMode="numeric"
                                                    maxLength={8}
                                                    value={otp}
                                                    onChange={(e) => {
                                                        const val = e.target.value.replace(/\D/g, "").slice(0, 8);
                                                        setOtp(val);
                                                    }}
                                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-center"
                                                    autoComplete="one-time-code"
                                                />
                                            </div>

                                            {loading && (
                                                <div className="flex justify-center py-2">
                                                    <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
                                                </div>
                                            )}

                                            <div className="flex items-center justify-between mt-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setStep("email")}
                                                    className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 hover:underline py-2 transition-colors"
                                                >
                                                    Edit email
                                                </button>

                                                <button
                                                    type="button"
                                                    onClick={handleResendOtp}
                                                    disabled={resendTimer > 0 || loading}
                                                    className={`text-sm py-2 transition-colors ${resendTimer > 0 ? "text-zinc-400 cursor-not-allowed" : "text-zinc-900 dark:text-white hover:underline"}`}
                                                >
                                                    {resendTimer > 0 ? `Resend in ${resendTimer}s` : "Resend code"}
                                                </button>
                                            </div>
                                        </form>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Footer */}
                        <div className="mt-8 text-center">
                            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                                By continuing, you agree to our{" "}
                                <a
                                    href="/terms-of-use"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hover:text-zinc-900 dark:hover:text-zinc-300 underline"
                                >
                                    Terms of Service
                                </a>{" "}
                                and{" "}
                                <a
                                    href="/privacy-policy"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hover:text-zinc-900 dark:hover:text-zinc-300 underline"
                                >
                                    Privacy Policy
                                </a>
                                .
                            </p>
                        </div>
                    </div>
                </motion.div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<div className="min-h-dvh w-full bg-primary" />}>
            <LoginPageInner />
        </Suspense>
    );
}
