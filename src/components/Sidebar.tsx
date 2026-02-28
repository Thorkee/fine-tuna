"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Circle,
    PanelLeftClose,
    PanelLeftOpen,
    Search,
    SquarePen,
    Trash2,
    X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { db, type Chat } from "@/lib/db";
import type { ProfileTab, SettingsTab } from "@/app/components/ui/CreditsModal";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    useConnectionManager,
    createSmartPoll,
    broadcastSync,
    type SmartPollController,
    type SyncEvent,
} from "@/lib/hooks/useConnectionManager";

interface SidebarProps {
    onNewChat: () => void;
    onSelectChat: (chatId: string) => void;
    isDark: boolean;
    onToggleTheme: () => void;
    className?: string;
    activeChatId?: string | null;
    loadingChatId?: string | null;
    isChatLoading?: boolean;
    onOpenCredits?: (tab?: SettingsTab, profileTab?: ProfileTab) => void;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "tuna.sidebar.collapsed";
const SIDEBAR_WIDTH_COLLAPSED = "72px";
const SIDEBAR_WIDTH_EXPANDED = "280px";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function describeLoadError(error: unknown): string {
    if (error instanceof Error) {
        return error.message || "Unknown error";
    }
    if (typeof error === "string") return error;
    if (isRecord(error)) {
        const message = typeof error.message === "string" ? error.message : "";
        const code = typeof error.code === "string" ? error.code : "";
        const details = typeof error.details === "string" ? error.details : "";
        const hint = typeof error.hint === "string" ? error.hint : "";
        const parts = [
            message,
            code ? `code=${code}` : "",
            details ? `details=${details}` : "",
            hint ? `hint=${hint}` : "",
        ].filter(Boolean);
        if (parts.length > 0) return parts.join(" | ");
    }
    return "Unknown error";
}

function getInitials(label: string | null | undefined): string {
    if (!label) return "U";
    const cleaned = label.trim();
    if (!cleaned) return "U";
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "U";
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

type ChatGroup = { key: string; label: string; items: Chat[] };

function groupChatsByRecency(list: Chat[]): ChatGroup[] {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const startOfLast7 = new Date(startOfToday);
    startOfLast7.setDate(startOfLast7.getDate() - 7);
    const startOfLast30 = new Date(startOfToday);
    startOfLast30.setDate(startOfLast30.getDate() - 30);

    const groups: ChatGroup[] = [
        { key: "today", label: "Today", items: [] },
        { key: "yesterday", label: "Yesterday", items: [] },
        { key: "previous7", label: "Previous 7 days", items: [] },
        { key: "previous30", label: "Previous 30 days", items: [] },
        { key: "older", label: "Older", items: [] },
    ];

    list.forEach((chat) => {
        const createdAt = new Date(chat.created_at);
        if (Number.isNaN(createdAt.getTime())) {
            groups[4].items.push(chat);
            return;
        }

        if (createdAt >= startOfToday) {
            groups[0].items.push(chat);
        } else if (createdAt >= startOfYesterday) {
            groups[1].items.push(chat);
        } else if (createdAt >= startOfLast7) {
            groups[2].items.push(chat);
        } else if (createdAt >= startOfLast30) {
            groups[3].items.push(chat);
        } else {
            groups[4].items.push(chat);
        }
    });

    return groups.filter((group) => group.items.length > 0);
}

function parseCollapsedPref(value: string | null): boolean | null {
    if (value == null) return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
    if (normalized === "0" || normalized === "false" || normalized === "no") return false;
    return null;
}

function readCookieValue(key: string): string | null {
    try {
        const part = document.cookie
            .split("; ")
            .find((p) => p.indexOf(`${key}=`) === 0);
        if (!part) return null;
        return decodeURIComponent(part.split("=")[1] ?? "");
    } catch {
        return null;
    }
}

function parseCreditsValue(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return null;
}

function parseCreditsTotal(value: unknown): number | null {
    const direct = parseCreditsValue(value);
    if (typeof direct === "number") return direct;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const total = parseCreditsValue(record.total_credits);
    if (typeof total === "number") return total;
    const base = parseCreditsValue(record.credits_balance);
    const daily = parseCreditsValue(record.daily_credits_balance);
    if (typeof base === "number" && typeof daily === "number") return base + daily;
    return null;
}

function formatCreditsShort(value: number | null, loading: boolean): string {
    if (loading) return "…";
    if (value === null) return "—";
    const abs = Math.abs(value);
    if (abs < 1000) return `${Math.round(value)}`;
    if (abs < 1_000_000) {
        const k = value / 1000;
        return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
    }
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
}

export default function Sidebar({
    onNewChat,
    onSelectChat,
    isDark,
    onToggleTheme,
    className,
    activeChatId,
    loadingChatId,
    isChatLoading,
    onOpenCredits,
}: SidebarProps) {
    const [collapsed, setCollapsed] = useState(() => {
        if (typeof window === "undefined") return false;
        try {
            const fromStorage = parseCollapsedPref(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY));
            if (fromStorage !== null) return fromStorage;
        } catch {
            // ignore (localStorage may be unavailable)
        }
        const fromCookie = parseCollapsedPref(readCookieValue(SIDEBAR_COLLAPSED_STORAGE_KEY));
        return fromCookie ?? false;
    });
    const [chats, setChats] = useState<Chat[]>([]);
    const chatsHashRef = useRef<string>("");
    const profileMenuRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const supabase = useMemo(() => createClient(), []);
    const [profileMenuOpen, setProfileMenuOpen] = useState(false);
    const [profileName, setProfileName] = useState<string | null>(null);
    const [profileEmail, setProfileEmail] = useState<string | null>(null);
    const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
    const [pendingDeleteChat, setPendingDeleteChat] = useState<Chat | null>(null);
    const [deleteError, setDeleteError] = useState<string>("");
    const [isDeletingChat, setIsDeletingChat] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchActiveKey, setSearchActiveKey] = useState<string>("new");
    const lastLoadErrorRef = useRef<string>("");
    const lastCreditsErrorRef = useRef<string>("");
    const [creditsBalance, setCreditsBalance] = useState<number | null>(null);
    const [creditsLoading, setCreditsLoading] = useState(false);

    useEffect(() => {
        // Keep in sync for refresh pre-paint init script + layout placeholder.
        try {
            document.documentElement.setAttribute("data-sidebar-collapsed", collapsed ? "1" : "0");
            document.documentElement.style.setProperty(
                "--sidebar-width",
                collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED
            );
        } catch {
            // ignore
        }

        try {
            window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
        } catch {
            // ignore (localStorage may be unavailable)
        }

        try {
            document.cookie = `${SIDEBAR_COLLAPSED_STORAGE_KEY}=${encodeURIComponent(
                collapsed ? "1" : "0"
            )}; path=/; max-age=31536000; samesite=lax`;
        } catch {
            // ignore (cookies may be unavailable)
        }
    }, [collapsed]);

    const chatPollRef = useRef<SmartPollController | null>(null);
    const creditsPollRef = useRef<SmartPollController | null>(null);

    const loadChats = useCallback(async () => {
        try {
            const data = await db.getChats();
            const nextHash = data.map((c) => `${c.id}:${c.title}:${c.created_at}`).join("|");
            if (nextHash !== chatsHashRef.current) {
                chatsHashRef.current = nextHash;
                setChats(data);
            }
            lastLoadErrorRef.current = "";
            chatPollRef.current?.success();
        } catch (error) {
            const message = describeLoadError(error);
            if (message !== lastLoadErrorRef.current) {
                lastLoadErrorRef.current = message;
                console.error("Failed to load chats:", message, error);
            }
            chatPollRef.current?.failure();
        }
    }, []);

    // Smart polling for chat list updates with visibility awareness and backoff
    useEffect(() => {
        const poll = createSmartPoll(loadChats, {
            baseInterval: 10_000,
            maxInterval: 30_000,
            pauseWhenHidden: true,
            immediate: true,
        });
        chatPollRef.current = poll;
        poll.start();
        return () => {
            poll.stop();
            chatPollRef.current = null;
        };
    }, [loadChats]);

    // Listen for cross-tab events that affect the chat list
    useConnectionManager({
        onVisibilityRestore: () => {
            chatPollRef.current?.forceNow();
            creditsPollRef.current?.forceNow();
        },
        onOnline: () => {
            chatPollRef.current?.forceNow();
            creditsPollRef.current?.forceNow();
        },
        onSyncEvent: (event: SyncEvent) => {
            // Immediately refresh when another tab creates/deletes/updates a chat
            if (
                event.type === "chat-created" ||
                event.type === "chat-deleted" ||
                event.type === "chat-updated" ||
                event.type === "force-refresh"
            ) {
                chatPollRef.current?.forceNow();
            }
        },
    });

    const deleteChat = async (chatId: string) => {
        try {
            await db.deleteChat(chatId);
            setChats((prev) => {
                const next = prev.filter((c) => c.id !== chatId);
                chatsHashRef.current = next.map((c) => `${c.id}:${c.title}:${c.created_at}`).join("|");
                return next;
            });
            // Notify other tabs about deletion
            broadcastSync("chat-deleted", { chatId });
        } catch (error) {
            console.error("Failed to delete chat:", error);
            throw error;
        }
    }

    const requestDeleteChat = (e: React.MouseEvent, chat: Chat) => {
        e.stopPropagation();
        setDeleteError("");
        setPendingDeleteChat(chat);
    };

    const confirmDeleteChat = async () => {
        if (!pendingDeleteChat || isDeletingChat) return;
        const chatId = pendingDeleteChat.id;
        setIsDeletingChat(true);
        setDeleteError("");
        try {
            await deleteChat(chatId);
            setPendingDeleteChat(null);
            if (activeChatId && chatId === activeChatId) {
                onNewChat();
            }
        } catch (error) {
            const message = describeLoadError(error);
            setDeleteError(message || "Failed to delete chat.");
        } finally {
            setIsDeletingChat(false);
        }
    };

    const cancelDeleteChat = () => {
        if (isDeletingChat) return;
        setDeleteError("");
        setPendingDeleteChat(null);
    };

    const handleSignOut = async () => {
        setProfileMenuOpen(false);
        await supabase.auth.signOut();
        router.refresh();
    };

    const currentPath = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
    const displayName = (profileName && profileName.trim()) || profileEmail || "Account";
    const avatarLabel = getInitials(displayName);
    const needsOnboarding = onboardingCompleted === false;
    const handlePersonalize = useCallback(() => {
        setProfileMenuOpen(false);
        if (!needsOnboarding && onOpenCredits) {
            onOpenCredits("account", "profile");
            return;
        }
        const nextParam = encodeURIComponent(currentPath || "/");
        router.push(`/onboarding?edit=1&next=${nextParam}`);
    }, [currentPath, needsOnboarding, onOpenCredits, router]);

    const handleOpenCredits = useCallback(() => {
        setProfileMenuOpen(false);
        if (onOpenCredits) {
            onOpenCredits("usage");
            return;
        }
        router.push("/settings/usage");
    }, [onOpenCredits, router]);

    const loadCredits = useCallback(async () => {
        setCreditsLoading(true);
        try {
            const { data, error } = await supabase.rpc("get_credit_summary");
            if (error) {
                const fallback = await supabase.rpc("get_credit_balance");
                if (fallback.error) {
                    setCreditsBalance(null);
                    const message = `${fallback.error.message || "Failed to load credits"}${
                        fallback.error.code ? ` (code=${fallback.error.code})` : ""
                    }`;
                    if (message !== lastCreditsErrorRef.current) {
                        lastCreditsErrorRef.current = message;
                        console.error("Failed to load credits balance:", message, fallback.error);
                    }
                } else {
                    lastCreditsErrorRef.current = "";
                    setCreditsBalance(parseCreditsValue(fallback.data));
                }
            } else {
                lastCreditsErrorRef.current = "";
                setCreditsBalance(parseCreditsTotal(data));
            }
        } catch (err) {
            setCreditsBalance(null);
            const message = describeLoadError(err);
            if (message !== lastCreditsErrorRef.current) {
                lastCreditsErrorRef.current = message;
                console.error("Failed to load credits balance:", message, err);
            }
        } finally {
            setCreditsLoading(false);
        }
    }, [supabase]);

    useEffect(() => {
        const poll = createSmartPoll(loadCredits, {
            baseInterval: 30_000,
            maxInterval: 120_000,
            pauseWhenHidden: true,
            immediate: true,
        });
        creditsPollRef.current = poll;
        poll.start();
        return () => {
            poll.stop();
            creditsPollRef.current = null;
        };
    }, [loadCredits]);

    const creditsBadgeLabel = useMemo(
        () => formatCreditsShort(creditsBalance, creditsLoading),
        [creditsBalance, creditsLoading]
    );

    const openSearch = useCallback(() => {
        setProfileMenuOpen(false);
        setPendingDeleteChat(null);
        setSearchQuery("");
        setSearchActiveKey("new");
        setSearchOpen(true);
    }, []);

    const closeSearch = useCallback(() => {
        setSearchOpen(false);
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function loadProfile() {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user || cancelled) return;

            setProfileEmail(user.email ?? null);

            const { data: profile } = await supabase
                .from("profiles")
                .select("full_name,onboarding_completed")
                .eq("id", user.id)
                .maybeSingle();

            if (cancelled) return;

            if (profile?.full_name) setProfileName(profile.full_name);
            if (typeof profile?.onboarding_completed === "boolean") {
                setOnboardingCompleted(profile.onboarding_completed);
            }
        }

        void loadProfile();
        return () => {
            cancelled = true;
        };
    }, [supabase]);

    useEffect(() => {
        if (!profileMenuOpen) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (!profileMenuRef.current) return;
            if (!profileMenuRef.current.contains(event.target as Node)) {
                setProfileMenuOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setProfileMenuOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [profileMenuOpen]);

    useEffect(() => {
        if (!pendingDeleteChat) return;

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                if (isDeletingChat) return;
                setDeleteError("");
                setPendingDeleteChat(null);
            }
        };

        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("keydown", handleEscape);
        };
    }, [isDeletingChat, pendingDeleteChat]);

    // Open search via Cmd/Ctrl+K (ChatGPT-style)
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const key = event.key.toLowerCase();
            if ((event.metaKey || event.ctrlKey) && key === "k") {
                event.preventDefault();
                openSearch();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [openSearch]);

    // Manage search focus + body scroll lock.
    useEffect(() => {
        if (!searchOpen) return;

        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        const raf = window.requestAnimationFrame(() => {
            searchInputRef.current?.focus();
        });

        return () => {
            document.body.style.overflow = prevOverflow;
            window.cancelAnimationFrame(raf);
        };
    }, [searchOpen]);

    const filteredChats = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return chats;
        return chats.filter((c) => (c.title ?? "").toLowerCase().includes(q));
    }, [chats, searchQuery]);

    const searchOptionKeys = useMemo(
        () => ["new", ...filteredChats.map((c) => c.id)],
        [filteredChats]
    );

    const safeSearchActiveKey = useMemo(() => {
        return searchOptionKeys.includes(searchActiveKey) ? searchActiveKey : (searchOptionKeys[0] ?? "new");
    }, [searchActiveKey, searchOptionKeys]);

    const handleSearchQueryChange = useCallback(
        (nextValue: string) => {
            setSearchQuery(nextValue);
            const q = nextValue.trim().toLowerCase();
            if (!q) {
                setSearchActiveKey("new");
                return;
            }
            const matches = chats.filter((c) => (c.title ?? "").toLowerCase().includes(q));
            setSearchActiveKey(matches[0]?.id ?? "new");
        },
        [chats]
    );

    // Keyboard navigation inside search modal.
    useEffect(() => {
        if (!searchOpen) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
                return;
            }

            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSearchActiveKey((prev) => {
                    const idx = Math.max(0, searchOptionKeys.indexOf(prev));
                    const dir = event.key === "ArrowDown" ? 1 : -1;
                    const nextIdx = (idx + dir + searchOptionKeys.length) % searchOptionKeys.length;
                    return searchOptionKeys[nextIdx] ?? "new";
                });
                return;
            }

            if (event.key === "Enter") {
                event.preventDefault();
                const activeKey = safeSearchActiveKey;
                if (activeKey === "new") {
                    closeSearch();
                    onNewChat();
                    return;
                }
                if (activeKey) {
                    closeSearch();
                    onSelectChat(activeKey);
                }
            }
        };

        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [closeSearch, onNewChat, onSelectChat, safeSearchActiveKey, searchOpen, searchOptionKeys]);

    const chatGroups = useMemo(() => {
        return groupChatsByRecency(chats);
    }, [chats]);

    const filteredChatGroups = useMemo(() => {
        return groupChatsByRecency(filteredChats);
    }, [filteredChats]);

    const handleSidebarClick = useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            if (!collapsed) return;
            const target = event.target as HTMLElement | null;
            if (!target) return;

            // When collapsed, avoid auto-expanding when the user clicks an actual control
            // (e.g. "New chat"). Otherwise the sidebar can briefly expand before navigation/close
            // animations complete, which looks glitchy.
            if (
                target.closest(
                    'button, a, input, textarea, select, [role="button"], [data-sidebar-no-expand="true"]'
                )
            ) {
                return;
            }

            if (profileMenuRef.current?.contains(target)) {
                return;
            }
            setCollapsed(false);
        },
        [collapsed]
    );

    return (
        <TooltipProvider delayDuration={0}>
            <motion.aside
                data-tuna-sidebar="1"
                initial={false}
                animate={collapsed ? "collapsed" : "expanded"}
                variants={{
                    expanded: { width: 280 },
                    collapsed: { width: 72 },
                }}
                transition={{ type: "spring", stiffness: 280, damping: 32, mass: 0.8 }}
                onClick={handleSidebarClick}
                className={cn(
                    "h-dvh flex flex-col relative shrink-0 bg-secondary text-primary",
                    collapsed && profileMenuOpen ? "z-[70]" : "z-20",
                    collapsed ? "cursor-col-resize" : "cursor-default",
                    collapsed ? "overflow-visible" : "overflow-hidden",
                    className
                )}
                style={{ willChange: "width" }}
            >
                {/* Top Navigation Bar in Sidebar */}
                <motion.div
                    layout
                    transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.6 }}
                    className={cn(
                        "flex px-2 py-3",
                        collapsed ? "flex-col gap-2 h-auto items-stretch" : "items-center justify-between h-14"
                    )}
                >
                    {/* Logo (hide entirely when collapsed) */}
                    {!collapsed && (
                        <motion.div
                            layout
                            transition={{ type: "spring", stiffness: 280, damping: 32, mass: 0.8 }}
                            className="flex items-center justify-start"
                        >
                            <motion.div
                                layout
                                transition={{ type: "spring", stiffness: 280, damping: 32, mass: 0.8 }}
                                className="rounded-lg flex items-center justify-start"
                                animate={{
                                    paddingLeft: 4,
                                    paddingRight: 0,
                                    paddingTop: 3,
                                    paddingBottom: 3,
                                }}
                            >
                                <motion.div
                                    className="relative"
                                    animate={{
                                        width: 220,
                                        height: 36,
                                        opacity: 1,
                                    }}
                                    transition={{ type: "spring", stiffness: 280, damping: 32, mass: 0.8 }}
                                    style={{ willChange: "width, height, opacity" }}
                                >
                                    <Image
                                        src="/tuna.png"
                                        alt="tuna"
                                        fill
                                        sizes="220px"
                                        className="object-contain object-left"
                                        priority={false}
                                    />
                                </motion.div>
                            </motion.div>
                        </motion.div>
                    )}

                    {/* Toggle Button */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <motion.button
                                layout
                                onClick={() => setCollapsed(!collapsed)}
                                className={cn(
                                    "rounded-lg transition-colors duration-200 text-secondary hover:text-primary hover:bg-tertiary",
                                    collapsed
                                        ? "w-full flex items-center justify-start px-3 py-2"
                                        : "p-2 shrink-0"
                                )}
                            >
                                <AnimatePresence mode="wait" initial={false}>
                                    <motion.span
                                        key={collapsed ? "open" : "close"}
                                        initial={{ opacity: 0, rotate: collapsed ? -90 : 90, scale: 0.9 }}
                                        animate={{ opacity: 1, rotate: 0, scale: 1 }}
                                        exit={{ opacity: 0, rotate: collapsed ? 90 : -90, scale: 0.9 }}
                                        transition={{ duration: 0.16, ease: [0.19, 1, 0.22, 1] }}
                                        className="block"
                                    >
                                        {collapsed ? (
                                            <PanelLeftOpen className="w-4 h-4" />
                                        ) : (
                                            <PanelLeftClose className="w-4 h-4" />
                                        )}
                                    </motion.span>
                                </AnimatePresence>
                            </motion.button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                            <p>{collapsed ? "Expand Sidebar" : "Collapse Sidebar"}</p>
                        </TooltipContent>
                    </Tooltip>
                </motion.div>

                {/* Main Content Area */}
                <div className="flex-1 flex flex-col min-h-0 pt-1">
                    {/* Quick actions (ChatGPT-style) */}
                    <div className={cn("px-2", collapsed ? "pt-1" : "pt-0")}>
                        <div className="space-y-1">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <motion.button
                                        layout
                                        transition={{ type: "spring", stiffness: 520, damping: 44, mass: 0.7 }}
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setProfileMenuOpen(false);
                                            closeSearch();
                                            onNewChat();
                                        }}
                                        className={cn(
                                            "w-full flex items-center rounded-lg transition-colors text-primary hover:bg-tertiary",
                                            collapsed ? "justify-start px-3 py-2" : "justify-start px-3 py-2.5"
                                        )}
                                    >
                                        <motion.span layout className="shrink-0">
                                            <SquarePen className="w-4 h-4" />
                                        </motion.span>
                                        <motion.span
                                            layout
                                            initial={false}
                                            animate={{
                                                opacity: collapsed ? 0 : 1,
                                                maxWidth: collapsed ? 0 : 320,
                                                marginLeft: collapsed ? 0 : 12,
                                                x: collapsed ? -4 : 0,
                                            }}
                                            transition={{ duration: 0.18, ease: [0.19, 1, 0.22, 1] }}
                                            className="overflow-hidden whitespace-nowrap text-[15px] font-medium"
                                            style={{ willChange: "max-width, opacity, transform" }}
                                            aria-hidden={collapsed}
                                        >
                                            New chat
                                        </motion.span>
                                    </motion.button>
                                </TooltipTrigger>
                                {collapsed && (
                                    <TooltipContent side="right">
                                        <p>New chat</p>
                                    </TooltipContent>
                                )}
                            </Tooltip>

                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <motion.button
                                        layout
                                        transition={{ type: "spring", stiffness: 520, damping: 44, mass: 0.7 }}
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            openSearch();
                                        }}
                                        className={cn(
                                            "w-full flex items-center rounded-lg transition-colors text-primary hover:bg-tertiary",
                                            collapsed ? "justify-start px-3 py-2" : "justify-start px-3 py-2.5"
                                        )}
                                    >
                                        <motion.span layout className="shrink-0">
                                            <Search className="w-4 h-4" />
                                        </motion.span>
                                        <motion.span
                                            layout
                                            initial={false}
                                            animate={{
                                                opacity: collapsed ? 0 : 1,
                                                maxWidth: collapsed ? 0 : 999,
                                                marginLeft: collapsed ? 0 : 12,
                                                x: collapsed ? -4 : 0,
                                            }}
                                            transition={{ duration: 0.18, ease: [0.19, 1, 0.22, 1] }}
                                            className="overflow-hidden whitespace-nowrap text-[15px] font-medium"
                                            style={{ willChange: "max-width, opacity, transform" }}
                                            aria-hidden={collapsed}
                                        >
                                            Search chats
                                        </motion.span>
                                    </motion.button>
                                </TooltipTrigger>
                                {collapsed && (
                                    <TooltipContent side="right">
                                        <p>Search chats</p>
                                    </TooltipContent>
                                )}
                            </Tooltip>
                        </div>
                    </div>

                    <div
                        className={cn(
                            "mx-3 my-2 h-px bg-[hsl(var(--border-default))]",
                            collapsed && "mx-4"
                        )}
                    />

                    <AnimatePresence mode="wait" initial={false}>
                        {!collapsed && (
                            <motion.div
                                key="sidebar-content"
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -10 }}
                                transition={{ duration: 0.18, ease: [0.19, 1, 0.22, 1] }}
                                className="flex-1 flex flex-col min-h-0"
                                style={{ willChange: "transform, opacity" }}
                            >
                                {/* Chat History List */}
                                <div className="flex-1 overflow-y-auto px-2 pb-2 scrollbar-hide">
                                    <div className="space-y-4">
                                        <div className="px-3 pt-2 text-xs font-semibold select-none text-muted">
                                            Your chats
                                        </div>
                                        {chatGroups.map((group) => (
                                            <div key={group.key}>
                                                <div className="px-3 pt-3 pb-1 text-xs font-medium select-none text-secondary">
                                                    {group.label}
                                                </div>
                                                <div className="space-y-[2px]">
                                                    <AnimatePresence initial={false}>
                                                        {group.items.map((item) => {
                                                            const isActive = item.id === activeChatId;
                                                            const isLoadingChat = Boolean(isChatLoading && loadingChatId === item.id);

                                                            return (
                                                                <motion.div
                                                                    key={item.id}
                                                                    layout="position"
                                                                    initial={{ opacity: 0, y: 6 }}
                                                                    animate={{ opacity: 1, y: 0 }}
                                                                    exit={{ opacity: 0, y: -6 }}
                                                                    transition={{ duration: 0.16, ease: [0.19, 1, 0.22, 1] }}
                                                                    onClick={() => {
                                                                        if (isLoadingChat) return;
                                                                        setProfileMenuOpen(false);
                                                                        onSelectChat(item.id);
                                                                    }}
                                                                    aria-busy={isLoadingChat}
                                                                    aria-current={isActive ? "page" : undefined}
                                                                    className={cn(
                                                                        "group relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer text-primary hover:bg-tertiary",
                                                                        isActive && "bg-tertiary",
                                                                        isLoadingChat && "cursor-progress"
                                                                    )}
                                                                >
                                                                    <div className="truncate flex-1 pr-10 font-normal">
                                                                        {item.title}
                                                                    </div>

                                                                    {/* Actions & Status */}
                                                                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                                                        {isLoadingChat && (
                                                                            <span
                                                                                className={cn(
                                                                                    "inline-flex h-3 w-3 animate-spin rounded-full border border-current border-t-transparent text-muted"
                                                                                )}
                                                                            />
                                                                        )}
                                                                        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                                            <button
                                                                                onClick={(e) => requestDeleteChat(e, item)}
                                                                                disabled={isLoadingChat}
                                                                                className="p-1 rounded-md transition-colors text-muted hover:text-primary hover:bg-tertiary"
                                                                            >
                                                                                <Trash2 className="w-3.5 h-3.5" />
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                </motion.div>
                                                            );
                                                        })}
                                                    </AnimatePresence>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Footer / User Profile */}
                <div
                    className={cn(
                        "p-2 mt-auto",
                        !collapsed && "p-3 border-t border-default"
                    )}
                >
                    <div className={cn("flex flex-col", collapsed ? "items-stretch gap-2" : "gap-2")}>
                        {!collapsed && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label={`View credits (${creditsBadgeLabel})`}
                                        onClick={handleOpenCredits}
                                        className="group w-full px-1.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30 text-secondary hover:text-primary"
                                    >
                                        <span className="flex w-full items-center justify-between rounded-full px-3 py-2 border transition-colors border-default bg-tertiary hover:bg-elevated">
                                            <span className="flex items-center gap-2">
                                                <span className="text-[10px] uppercase tracking-wide text-muted">
                                                    Credits
                                                </span>
                                            </span>
                                            <span className="tabular-nums text-[12px] font-semibold text-secondary">
                                                {creditsBadgeLabel}
                                            </span>
                                        </span>
                                    </button>
                                </TooltipTrigger>
                            </Tooltip>
                        )}

                        <div
                            ref={profileMenuRef}
                            className={cn("relative", collapsed ? "w-8 self-center" : "w-full")}
                        >
                        <AnimatePresence mode="wait" initial={false}>
                            {collapsed ? (
                                <motion.div
                                    key="footer-collapsed"
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 8 }}
                                    transition={{ duration: 0.16, ease: [0.19, 1, 0.22, 1] }}
                                >
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                onClick={() => setProfileMenuOpen((prev) => !prev)}
                                                className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 cursor-pointer shadow-sm transition-colors bg-tertiary text-primary hover:bg-elevated"
                                            >
                                                {avatarLabel}
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent side="right">
                                            <p>{displayName}</p>
                                        </TooltipContent>
                                    </Tooltip>
                                </motion.div>
                            ) : (
                                <motion.div
                                    key="footer-expanded"
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 8 }}
                                    transition={{ duration: 0.18, ease: [0.19, 1, 0.22, 1] }}
                                    className="w-full"
                                >
                                    <button
                                        onClick={() => setProfileMenuOpen((prev) => !prev)}
                                        className="w-full flex items-center gap-3 px-2 py-3 rounded-lg transition-colors hover:bg-tertiary"
                                    >
                                        <div
                                            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 bg-tertiary text-primary"
                                        >
                                            {avatarLabel}
                                        </div>
                                        <div className="flex-1 min-w-0 text-left">
                                            <div className="text-sm font-medium truncate text-primary">
                                                {displayName}
                                            </div>
                                            {needsOnboarding && (
                                                <div className="mt-0.5 text-[11px] text-[hsl(var(--accent-green))]">
                                                    Complete onboarding
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <AnimatePresence>
                            {profileMenuOpen && (
                                <motion.div
                                    key="profile-menu"
                                    initial={{ opacity: 0, y: 6, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: 6, scale: 0.98 }}
                                    transition={{ duration: 0.14, ease: [0.19, 1, 0.22, 1] }}
                                    className={cn(
                                        "absolute bottom-full mb-2 w-56 rounded-xl border shadow-xl overflow-hidden z-50 bg-elevated text-primary border-default shadow-black/20",
                                        collapsed ? "left-0" : "right-0"
                                    )}
                                >
                                    <div className="px-3 pt-3 pb-2">
                                        <div className="text-xs uppercase tracking-wide text-muted">
                                            Signed in
                                        </div>
                                        <div className="mt-1 text-sm font-medium truncate">
                                            {displayName}
                                        </div>
                                        {profileEmail && (
                                            <div className="mt-0.5 text-xs truncate text-muted">
                                                {profileEmail}
                                            </div>
                                        )}
                                    </div>
                                    <div className="h-px bg-[hsl(var(--border-default))]" />
                                    <button
                                        onClick={handlePersonalize}
                                        className="w-full text-left px-3 py-2.5 text-sm transition-colors text-primary hover:bg-tertiary"
                                    >
                                        {needsOnboarding ? "Complete onboarding" : "Settings"}
                                    </button>
                                    <button
                                        onClick={handleOpenCredits}
                                        className="w-full text-left px-3 py-2.5 text-sm transition-colors text-primary hover:bg-tertiary"
                                    >
                                        Usage & billing
                                    </button>
                                    <button
                                        onClick={onToggleTheme}
                                        className="w-full flex items-center justify-between px-3 py-2 text-sm transition-colors text-primary hover:bg-tertiary"
                                    >
                                        <span>Theme</span>
                                        <span
                                            className="text-xs text-muted"
                                        >
                                            {isDark ? "Dark" : "Light"}
                                        </span>
                                    </button>
                                    <button
                                        onClick={handleSignOut}
                                        className="w-full text-left px-3 py-2.5 text-sm transition-colors text-primary hover:bg-tertiary"
                                    >
                                        Sign out
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
                </div>
            </motion.aside>

            <AnimatePresence>
                {searchOpen && (
                    <motion.div
                        key="search-chats-modal"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.14, ease: [0.19, 1, 0.22, 1] }}
                        className={cn(
                            "fixed inset-0 z-[60] flex items-start justify-center p-4 sm:p-6",
                            isDark ? "bg-black/60" : "bg-black/20",
                            "backdrop-blur-sm"
                        )}
                        onClick={closeSearch}
                    >
                        <motion.div
                            initial={{ opacity: 0, y: -10, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -10, scale: 0.98 }}
                            transition={{ duration: 0.18, ease: [0.19, 1, 0.22, 1] }}
                            className="mt-[10vh] w-full max-w-[640px] rounded-2xl border border-default shadow-2xl overflow-hidden bg-elevated text-primary shadow-black/25"
                            role="dialog"
                            aria-modal="true"
                            aria-label="Search chats"
                            onClick={(event) => event.stopPropagation()}
                        >
                            <div className="border-b py-2 border-default">
                                <div
                                    className={cn(
                                        "mx-2 flex items-center gap-3 rounded-lg px-3 py-2",
                                        "bg-tertiary"
                                    )}
                                >
                                    <Search className="w-4 h-4 text-muted" />
                                    <input
                                        ref={searchInputRef}
                                        value={searchQuery}
                                        onChange={(e) => handleSearchQueryChange(e.target.value)}
                                        placeholder="Search chats..."
                                        className="flex-1 bg-transparent outline-none text-sm text-primary placeholder:text-[hsl(var(--text-muted))]"
                                    />
                                    <button
                                        type="button"
                                        onClick={closeSearch}
                                        aria-label="Close search"
                                        className="p-1.5 rounded-lg transition-colors text-muted hover:text-primary hover:bg-tertiary"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            <div className="max-h-[60vh] overflow-y-auto py-2">
                                <button
                                    type="button"
                                    onMouseEnter={() => setSearchActiveKey("new")}
                                    onFocus={() => setSearchActiveKey("new")}
                                    onClick={() => {
                                        closeSearch();
                                        onNewChat();
                                    }}
                                    className={cn(
                                        "mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                                        safeSearchActiveKey === "new" ? "bg-tertiary" : "hover:bg-tertiary"
                                    )}
                                >
                                    <SquarePen className="w-4 h-4" />
                                    <span className="flex-1 min-w-0 truncate text-left">New chat</span>
                                </button>

                                <div className="mx-4 my-2 h-px bg-[hsl(var(--border-default))]" />

                                {filteredChats.length === 0 && searchQuery.trim() ? (
                                    <div className="px-4 py-6 text-sm text-muted">
                                        No chats found.
                                    </div>
                                ) : (
                                    <div className="pb-2">
                                        {filteredChatGroups.map((group) => (
                                            <div key={group.key}>
                                                <div className="px-4 pt-2 pb-1 text-xs font-medium select-none text-secondary">
                                                    {group.label}
                                                </div>
                                                <div className="space-y-1">
                                                    {group.items.map((chat) => (
                                                        <button
                                                            key={chat.id}
                                                            type="button"
                                                            onMouseEnter={() => setSearchActiveKey(chat.id)}
                                                            onFocus={() => setSearchActiveKey(chat.id)}
                                                            onClick={() => {
                                                                closeSearch();
                                                                onSelectChat(chat.id);
                                                            }}
                                                            className={cn(
                                                                "mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                                                                safeSearchActiveKey === chat.id
                                                                    ? "bg-tertiary"
                                                                    : "hover:bg-tertiary"
                                                            )}
                                                        >
                                                            <Circle className="w-4 h-4 text-muted" />
                                                            <span className="flex-1 min-w-0 truncate text-left">{chat.title}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {pendingDeleteChat && (
                    <motion.div
                        key="delete-chat-modal"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.16, ease: [0.19, 1, 0.22, 1] }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                        onClick={cancelDeleteChat}
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.97, y: 8 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.97, y: 8 }}
                            transition={{ duration: 0.18, ease: [0.19, 1, 0.22, 1] }}
                            className="w-[92%] max-w-sm rounded-2xl border border-default p-5 shadow-2xl bg-elevated text-primary shadow-black/25"
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="delete-chat-title"
                            onClick={(event) => event.stopPropagation()}
                        >
                            <div id="delete-chat-title" className="text-base font-semibold">
                                Delete chat?
                            </div>
                            <div className="mt-2 text-sm text-muted">
                                This will permanently delete &quot;{pendingDeleteChat.title || "Untitled chat"}&quot;.
                            </div>
                            {deleteError && (
                                <div className={cn(
                                    "mt-3 text-xs",
                                    isDark ? "text-red-300" : "text-red-600"
                                )}>
                                    {deleteError}
                                </div>
                            )}
                            <div className="mt-5 flex items-center justify-end gap-2">
                                <button
                                    type="button"
                                    onClick={cancelDeleteChat}
                                    disabled={isDeletingChat}
                                    className={cn(
                                        "px-3.5 py-2 rounded-lg text-sm font-medium transition-colors bg-tertiary text-primary hover:bg-elevated",
                                        isDeletingChat ? "opacity-60 cursor-not-allowed hover:bg-tertiary" : ""
                                    )}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={confirmDeleteChat}
                                    disabled={isDeletingChat}
                                    className={cn(
                                        "px-3.5 py-2 rounded-lg text-sm font-medium text-white bg-[#ef4444] hover:bg-[#dc2626] transition-colors",
                                        isDeletingChat ? "opacity-70 cursor-not-allowed hover:bg-[#ef4444]" : ""
                                    )}
                                >
                                    {isDeletingChat ? "Deleting..." : "Delete"}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </TooltipProvider>
    );
}
