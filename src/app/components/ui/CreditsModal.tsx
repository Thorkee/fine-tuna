"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar,
  Check,
  Compass,
  Copy,
  Cpu,
  LineChart,
  Link2,
  Palette,
  Settings,
  Sparkles,
  User,
  Wand2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { getDefaultMcpEnabledServers } from "@/lib/mcp/defaults";
import { createClient } from "@/lib/supabase/client";
import { useProjectStore } from "@/lib/store";
import type { ProjectMode } from "@/types";

type LedgerEntry = {
  id: string;
  entry_type: string;
  source?: string | null;
  amount: number | string;
  created_at?: string | null;
  chat_id?: string | null;
  chats?: { title?: string | null } | Array<{ title?: string | null }> | null;
};

type LedgerSummary = LedgerEntry & { amount: number; _latestTimestamp: number };

export type SettingsTab =
  | "account"
  | "settings"
  | "usage"
  | "controls"
  | "personalization"
  | "skills"
  | "integrations";

export type ProfileTab = "profile" | "knowledge";

type Goal = "train" | "analyze" | "compare" | "explore";
export type IntegrationProvider = "huggingface" | "github" | "kaggle" | "firecrawl";
type HuggingFaceSkillKey =
  | "search_hub"
  | "explore_datasets"
  | "query_dataset"
  | "get_documentation"
  | "run_spaces"
  | "train_model";
type HuggingFaceSkillState = Record<HuggingFaceSkillKey, boolean>;

type IntegrationStatusPayload = {
  hasToken?: boolean;
  error?: string;
};

type McpServerSummary = {
  id: string;
  label: string;
  transport: "stdio" | "http";
  toolCount?: number;
  origin?: "env" | "user";
};

type GithubRepoConnection = {
  id: string;
  repoFullName: string;
  isPrivate: boolean;
  baseBranch: string;
  workBranch: string;
  defaultPublishMode: "pr" | "direct";
  updatedAt: string;
};

function parseSignedCredits(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseBalance(value: unknown): number {
  return Math.max(0, parseSignedCredits(value));
}

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

function parseCreditSummary(value: unknown): { base: number; daily: number; total: number } {
  if (!isRecord(value)) {
    return { base: 0, daily: 0, total: 0 };
  }
  const base = parseBalance(value.credits_balance);
  const daily = parseBalance(value.daily_credits_balance);
  const total =
    typeof value.total_credits === "number" || typeof value.total_credits === "string"
      ? parseBalance(value.total_credits)
      : base + daily;
  return { base, daily, total };
}

function normalizePrefString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readMcpExplicitFlag(rawMcp: Record<string, unknown> | null): boolean {
  if (!rawMcp) return false;
  return rawMcp.explicit === true;
}

function isSameServerSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const id of b) {
    if (!setA.has(id)) return false;
  }
  return true;
}

function readMcpEnabledServers(
  prefs: Record<string, unknown>
): { enabledServers: string[]; hasExplicitConfig: boolean } {
  const rawMcp = isRecord(prefs.mcp) ? (prefs.mcp as Record<string, unknown>) : null;
  const explicit = readMcpExplicitFlag(rawMcp);
  const hasExplicitConfig = explicit;
  if (!explicit) {
    return { enabledServers: getDefaultMcpEnabledServers(), hasExplicitConfig };
  }
  const enabled = rawMcp ? toStringArray(rawMcp.enabled_servers) : [];
  return { enabledServers: enabled, hasExplicitConfig };
}

function formatCredits(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return `${Math.round(value)}`;
  if (abs < 1_000_000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  const m = value / 1_000_000;
  return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString();
}

function getInitials(label: string): string {
  const cleaned = label.trim();
  if (!cleaned) return "U";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

const goalOptions: Array<{ id: Goal; title: string; description: string; icon: LucideIcon }> = [
  {
    id: "train",
    title: "Train & fine-tune",
    description: "End-to-end training with scripts, compute, and exports.",
    icon: Cpu,
  },
  {
    id: "analyze",
    title: "Analyze data",
    description: "EDA and preprocessing insights to prepare training.",
    icon: LineChart,
  },
  {
    id: "compare",
    title: "Compare providers",
    description: "Pick the best provider, GPU, or cluster setup.",
    icon: Compass,
  },
  {
    id: "explore",
    title: "Just exploring",
    description: "See the full vibe-tuning workflow.",
    icon: Sparkles,
  },
];

const DEFAULT_HF_SKILLS: HuggingFaceSkillState = {
  search_hub: true,
  explore_datasets: true,
  query_dataset: true,
  get_documentation: true,
  run_spaces: true,
  train_model: true,
};

const huggingFaceSkillOptions: Array<{
  id: HuggingFaceSkillKey;
  title: string;
  description: string;
}> = [
  {
    id: "search_hub",
    title: "Search the Hub",
    description: "Find models, datasets, and Spaces with filters.",
  },
  {
    id: "explore_datasets",
    title: "Explore datasets",
    description: "Inspect dataset configs, splits, and schema.",
  },
  {
    id: "query_dataset",
    title: "Query a dataset",
    description: "Search or slice dataset rows via the viewer API.",
  },
  {
    id: "get_documentation",
    title: "Get documentation",
    description: "Fetch README/model cards and metadata.",
  },
  {
    id: "run_spaces",
    title: "Run Spaces",
    description: "Execute Spaces APIs when sandbox is insufficient.",
  },
  {
    id: "train_model",
    title: "Train a model",
    description: "Submit Jobs on Hugging Face compute.",
  },
];

const modeOptions: Array<{ id: ProjectMode; title: string; description: string; icon: LucideIcon }> = [
  {
    id: "own_data",
    title: "Own Data",
    description: "Bring your dataset—get a guided pipeline and artifacts.",
    icon: LineChart,
  },
  {
    id: "autonomous",
    title: "Autonomous",
    description: "The agent drives research + orchestration end-to-end.",
    icon: Wand2,
  },
];

type IntegrationLogoProps = { className?: string };
type ThemedLogoProps = IntegrationLogoProps & { isDark?: boolean };

const GithubLogo = ({ className }: IntegrationLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className={className}
  >
    <path
      fill="currentColor"
      d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
    />
  </svg>
);

const HuggingFaceLogo = ({ className }: IntegrationLogoProps) => (
  <img
    src="https://huggingface.co/datasets/huggingface/brand-assets/resolve/main/hf-logo.svg"
    alt="Hugging Face"
    className={className}
    loading="lazy"
  />
);

const MCP_LOGO_LIGHT =
  "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/mcp.png";
const MCP_LOGO_DARK =
  "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/dark/mcp.png";
const McpLogo = ({ className, isDark }: ThemedLogoProps) => (
  <img
    src={isDark ? MCP_LOGO_DARK : MCP_LOGO_LIGHT}
    alt="MCP"
    className={className}
    loading="lazy"
  />
);

const KaggleLogo = ({ className }: IntegrationLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className={className}
  >
    <path
      fill="currentColor"
      d="M.1025 7.3475c-.0681 0-.1022.0341-.1022.102v6.752c0 .0681.034.1022.1022.1022h.7049c.068 0 .1022-.034.1022-.1023v-1.481l.4187-.3985 1.5016 1.91c.041.0477.0884.0716.143.0716h.9091c.0476 0 .0748-.0135.0817-.0407.0135-.041.0066-.075-.0206-.1023l-1.9816-2.4618 1.9002-1.8384c.0204-.0205.0237-.051.01-.092-.0137-.0339-.0408-.051-.0816-.051h-.9398c-.0477 0-.0953.024-.143.0716L.9096 11.607V7.4496c0-.0679-.0342-.102-.1022-.102zm18.0417 0c-.068 0-.102.0341-.102.102v6.752c0 .0681.034.102.102.102h.705c.068 0 .102-.034.102-.102v-6.752c0-.068-.034-.102-.102-.102zM5.961 9.6254c-.5653 0-1.11.1806-1.6343.5415-.0545.0545-.0648.102-.0307.143l.3676.5208c.0272.0477.0717.0545.133.0204.3948-.2722.783-.4086 1.1644-.4086.2927 0 .5158.0886.669.2656.1532.1771.2197.3917.1992.6436-.6606.0681-1.1545.1495-1.4813.245-.8308.2383-1.2461.6913-1.2461 1.3586 0 .4222.1533.7695.4598 1.0419.3132.2654.6845.3982 1.1134.3982.4698 0 .8545-.1125 1.1542-.3372v.1432c0 .0682.0374.102.1123.102h.7048c.068 0 .102-.0338.102-.102V11.372c0-.6604-.2245-1.1406-.6739-1.4403-.3065-.2043-.6776-.3063-1.1134-.3063zm4.3225 0c-.6742 0-1.195.2622-1.5627.7865-.3133.4359-.4699.9671-.4699 1.5936 0 .6604.1634 1.2087.4903 1.6444.3744.4972.892.7455 1.5526.7455.5313 0 .9567-.1327 1.2768-.3982v.531c0 .858-.4122 1.287-1.236 1.287-.361 0-.732-.1907-1.1132-.572a.098.098 0 00-.0716-.0306c-.034 0-.0613.0102-.0817.0307l-.4802.48c-.0408.0613-.0375.1124.0103.1532.1361.1157.2554.2129.3576.2911.102.0783.1905.1413.2656.189.354.1975.7284.2961 1.1235.2961.6808 0 1.207-.1925 1.5781-.577.3711-.3848.5567-.9484.5567-1.6903V9.8196c0-.068-.034-.102-.102-.102h-.705c-.0682 0-.1021.034-.1021.102v.2043c-.3471-.2657-.7763-.3985-1.287-.3985zm4.8021 0c-.6742 0-1.195.2622-1.5627.7865-.3132.4359-.4699.9671-.4699 1.5936 0 .6604.1633 1.2087.4903 1.6444.3744.4972.892.7455 1.5526.7455.5311 0 .9566-.1327 1.2768-.3982v.531c0 .858-.4122 1.287-1.236 1.287-.361 0-.732-.1907-1.1133-.572a.098.098 0 00-.0716-.0306c-.034 0-.0612.0102-.0816.0307l-.48.48c-.0409.0613-.0376.1124.01.1532.1363.1157.2555.2129.3576.2911.1021.0783.1906.1413.2657.189.354.1975.7285.2961 1.1237.2961.6808 0 1.2068-.1925 1.5781-.577.371-.3848.5565-.9484.5565-1.6903V9.8196c0-.068-.034-.102-.102-.102h-.7049c-.0682 0-.1022.034-.1022.102v.2043c-.3474-.2657-.7763-.3985-1.287-.3985zm6.7457 0c-.6537 0-1.185.211-1.5936.6332-.4427.4632-.664 1.0283-.664 1.6956 0 .7083.225 1.2905.6743 1.7467.463.463 1.042.6945 1.7366.6945.6467 0 1.2154-.1838 1.7057-.5515.0545-.041.0545-.0884 0-.143l-.4802-.4903c-.041-.0409-.0919-.0409-.1533 0-.2998.2112-.6368.3167-1.0112.3167-.4222 0-.7729-.119-1.052-.3576-.2452-.2248-.3882-.5038-.429-.8375h3.3197c.0679 0 .1022-.0341.1022-.1023l.01-.2244c.0341-.6878-.1668-1.26-.6025-1.7162-.4224-.4426-.9432-.664-1.5627-.664zm-.0206.7865c.3268 0 .6062.1056.8377.3166.2452.211.371.4734.378.7865h-2.4618c.0613-.3269.2077-.5925.4392-.7968.2313-.2042.5004-.3063.8069-.3063zm-11.4249.102c.6196 0 1.0146.2181 1.1848.6538v1.6854c-.1702.4358-.5755.6538-1.2155.6538-.3133 0-.5687-.0986-.7661-.2963-.2656-.2518-.3983-.6538-.3983-1.2053 0-.9941.3984-1.4914 1.1951-1.4914zm4.802 0c.6196 0 1.0148.2181 1.1851.6538h-.0002v1.6854c-.1703.4358-.5755.6538-1.2155.6538-.3132 0-.5686-.0986-.7661-.2963-.2655-.2518-.3983-.6538-.3983-1.2053 0-.9941.3983-1.4914 1.195-1.4914zm-8.3586 1.6547v1.0215c-.286.286-.6675.412-1.1441.3779-.1703-.0135-.32-.0663-.4493-.1582-.1294-.0919-.2045-.2129-.2249-.3627-.0341-.2657.1158-.47.4495-.6129.2452-.1088.7013-.1974 1.3688-.2656z"
    />
  </svg>
);

const FirecrawlLogo = ({ className }: IntegrationLogoProps) => (
  <svg
    viewBox="0 0 50 72"
    aria-hidden="true"
    focusable="false"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    preserveAspectRatio="xMidYMid meet"
  >
    <path
      d="M41.7154 23.1929C38.9531 24.0129 36.8707 25.8677 35.3457 27.8826C35.0183 28.3151 34.3358 27.9901 34.4658 27.4601C37.3856 15.4534 33.5283 5.47401 21.5039 0.561817C20.894 0.311833 20.259 0.859299 20.419 1.49926C25.8887 23.4604 2.88236 21.608 5.78971 46.504C5.83971 46.9314 5.35973 47.2239 5.00975 46.9739C3.9198 46.1915 2.70237 44.5591 1.86741 43.4116C1.62242 43.0742 1.09245 43.1692 0.979951 43.5716C0.314984 45.9765 0 48.2413 0 50.4912C0 59.2407 4.49727 66.9427 11.3044 71.4074C11.6944 71.6624 12.1944 71.2974 12.0619 70.8499C11.7119 69.675 11.5144 68.4351 11.4994 67.1527C11.4994 66.3652 11.5494 65.5603 11.6719 64.8103C11.9569 62.9254 12.6119 61.1305 13.7118 59.4957C17.4841 53.8335 25.0462 48.3638 23.8388 40.9368C23.7613 40.4668 24.3163 40.1569 24.6663 40.4793C29.9935 45.3465 31.0485 51.8936 30.1735 57.7658C30.0985 58.2757 30.7385 58.5482 31.061 58.1482C31.8759 57.1283 32.8709 56.2334 33.9533 55.5609C34.2233 55.3934 34.5833 55.5209 34.6858 55.8209C35.2882 57.5733 36.1832 59.2182 37.0281 60.8631C38.0381 62.8404 38.5756 65.0978 38.4906 67.4877C38.4481 68.6501 38.2556 69.775 37.9331 70.8449C37.7956 71.2974 38.2906 71.6749 38.6881 71.4149C45.5002 66.9502 50 59.2482 50 50.4937C50 47.4514 49.4675 44.4691 48.4601 41.6743C46.3477 35.8121 40.988 31.4099 42.3429 23.7704C42.4079 23.4054 42.0704 23.0879 41.7154 23.1929Z"
      fill="#FA5D19"
    />
  </svg>
);

type IntegrationLogo = (props: IntegrationLogoProps) => ReactElement;

const integrationCatalog: Record<
  IntegrationProvider,
  {
    title: string;
    description: string;
    authUrl: string;
    authLabel: string;
    tokenLabel: string;
    tokenPlaceholder: string;
    tokenRotatePlaceholder: string;
    logo: IntegrationLogo;
  }
> = {
  github: {
    title: "GitHub",
    description: "Private repositories and code artifacts.",
    authUrl: "https://github.com/settings/tokens",
    authLabel: "Token page",
    tokenLabel: "Personal access token",
    tokenPlaceholder: "github_pat_xxx",
    tokenRotatePlaceholder: "Paste new token to rotate",
    logo: GithubLogo,
  },
  huggingface: {
    title: "Hugging Face",
    description: "Private models, datasets, and gated assets.",
    authUrl: "https://huggingface.co/settings/tokens",
    authLabel: "Token page",
    tokenLabel: "Access token",
    tokenPlaceholder: "hf_xxx",
    tokenRotatePlaceholder: "Paste new token to rotate",
    logo: HuggingFaceLogo,
  },
  kaggle: {
    title: "Kaggle",
    description: "Datasets, notebooks, and competitions.",
    authUrl: "https://www.kaggle.com/settings/account",
    authLabel: "Token page",
    tokenLabel: "API token (JSON or key)",
    tokenPlaceholder: "kaggle_api_key_or_json",
    tokenRotatePlaceholder: "Paste new token to rotate",
    logo: KaggleLogo,
  },
  firecrawl: {
    title: "Firecrawl",
    description: "Web data sourcing and extraction.",
    authUrl: "https://www.firecrawl.dev/",
    authLabel: "Dashboard",
    tokenLabel: "API key",
    tokenPlaceholder: "firecrawl_api_key",
    tokenRotatePlaceholder: "Paste new API key to rotate",
    logo: FirecrawlLogo,
  },
};

const integrationOrder: IntegrationProvider[] = ["github", "huggingface", "firecrawl", "kaggle"];

export type ThemePreference = "light" | "dark" | "system";

export default function CreditsModal(props: {
  open: boolean;
  onClose: () => void;
  isDark?: boolean;
  themePreference?: ThemePreference;
  onThemeChange?: (next: ThemePreference) => void;
  initialTab?: SettingsTab;
  initialProfileTab?: ProfileTab;
  initialIntegrationProvider?: IntegrationProvider;
}) {
  const {
    open,
    onClose,
    isDark = false,
    themePreference: themePreferenceProp,
    onThemeChange,
    initialTab = "usage",
    initialProfileTab = "profile",
    initialIntegrationProvider,
  } = props;
  const themePreference: ThemePreference = themePreferenceProp ?? (isDark ? "dark" : "light");
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const storedMode = useProjectStore((state) => state.mode);
  const setStoredMode = useProjectStore((state) => state.setMode);
  const [balance, setBalance] = useState<number>(0);
  const [dailyCredits, setDailyCredits] = useState<number>(0);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("usage");
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [nickname, setNickname] = useState("");
  const [occupation, setOccupation] = useState("");
  const [about, setAbout] = useState("");
  const [instructions, setInstructions] = useState("");
  const [goal, setGoal] = useState<Goal | null>(null);
  const [defaultMode, setDefaultMode] = useState<ProjectMode>(storedMode);
  const [basePreferences, setBasePreferences] = useState<Record<string, unknown>>({});
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPersonalization, setSavingPersonalization] = useState(false);
  const [savingControls, setSavingControls] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingIntegration, setSavingIntegration] = useState<IntegrationProvider | null>(null);
  const [removingIntegration, setRemovingIntegration] = useState<IntegrationProvider | null>(null);
  const [integrationFocusProvider, setIntegrationFocusProvider] = useState<IntegrationProvider | null>(null);
  const [integrationModalOpen, setIntegrationModalOpen] = useState(false);
  const [showGithubRepoForm, setShowGithubRepoForm] = useState(false);
  const [githubRepoConnections, setGithubRepoConnections] = useState<GithubRepoConnection[]>([]);
  const [githubReposLoading, setGithubReposLoading] = useState(false);
  const [savingGithubRepo, setSavingGithubRepo] = useState(false);
  const [removingGithubRepoId, setRemovingGithubRepoId] = useState<string | null>(null);
  const [githubRepoFullName, setGithubRepoFullName] = useState("");
  const [githubRepoPrivate, setGithubRepoPrivate] = useState(false);
  const [githubRepoBaseBranch, setGithubRepoBaseBranch] = useState("main");
  const [githubRepoWorkBranch, setGithubRepoWorkBranch] = useState("tuna");
  const [githubRepoPublishMode, setGithubRepoPublishMode] = useState<"pr" | "direct">("pr");
  const [profileTab, setProfileTab] = useState<ProfileTab>("profile");
  const [settingsEmailUpdates, setSettingsEmailUpdates] = useState(true);
  const [settingsQueuedTasks, setSettingsQueuedTasks] = useState(true);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [mcpEnabledServers, setMcpEnabledServers] = useState<string[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpFormLabel, setMcpFormLabel] = useState("");
  const [mcpFormUrl, setMcpFormUrl] = useState("");
  const [mcpFormHeaderName, setMcpFormHeaderName] = useState("");
  const [mcpFormHeaderValue, setMcpFormHeaderValue] = useState("");
  const [mcpFormError, setMcpFormError] = useState<string | null>(null);
  const [mcpFormNotice, setMcpFormNotice] = useState<string | null>(null);
  const [mcpSubmitting, setMcpSubmitting] = useState(false);
  const [mcpDeletingId, setMcpDeletingId] = useState<string | null>(null);
  const [mcpServersExpanded, setMcpServersExpanded] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpExplicit, setMcpExplicit] = useState(false);
  const availableMcpIds = useMemo(() => new Set(mcpServers.map((server) => server.id)), [mcpServers]);
  const [huggingFaceToken, setHuggingFaceToken] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [kaggleToken, setKaggleToken] = useState("");
  const [firecrawlToken, setFirecrawlToken] = useState("");
  const [huggingFaceSkills, setHuggingFaceSkills] = useState<HuggingFaceSkillState>(DEFAULT_HF_SKILLS);
  const [huggingFaceSkillsExpanded, setHuggingFaceSkillsExpanded] = useState(false);
  const [hasHuggingFaceToken, setHasHuggingFaceToken] = useState(false);
  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [hasKaggleToken, setHasKaggleToken] = useState(false);
  const [hasFirecrawlToken, setHasFirecrawlToken] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsNotice, setSkillsNotice] = useState<string | null>(null);
  const [savingSkills, setSavingSkills] = useState(false);
  const [skillsAutosaveNonce, setSkillsAutosaveNonce] = useState(0);
  const skillsAutosaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [integrationNotice, setIntegrationNotice] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);

  const refreshMcpServers = useCallback(async (): Promise<McpServerSummary[]> => {
    setMcpError(null);
    setMcpLoading(true);
    let nextServers: McpServerSummary[] = [];
    try {
      const response = await fetch("/api/mcp/servers", { method: "GET" });
      if (!response.ok) {
        if (response.status === 401) {
          setMcpServers([]);
          nextServers = [];
        } else {
          const payload = await response.json().catch(() => null);
          const message =
            typeof payload?.error === "string"
              ? payload.error
              : `Failed to load MCP servers (${response.status})`;
          throw new Error(message);
        }
      } else {
        const payload = (await response.json().catch(() => null)) as
          | { servers?: McpServerSummary[] }
          | null;
        nextServers = Array.isArray(payload?.servers) ? payload.servers : [];
        setMcpServers(nextServers);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load MCP servers.";
      setMcpError(message);
      setMcpServers([]);
      nextServers = [];
    } finally {
      setMcpLoading(false);
    }
    return nextServers;
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSkillsError(null);
    setSkillsNotice(null);
    try {
      const { data: summaryRaw, error: summaryErr } = await supabase.rpc("get_credit_summary");
      if (summaryErr) {
        const { data: balanceRaw, error: balanceErr } = await supabase.rpc("get_credit_balance");
        if (balanceErr) throw balanceErr;
        setBalance(parseBalance(balanceRaw));
        setDailyCredits(0);
      } else {
        const summary = parseCreditSummary(summaryRaw);
        setBalance(summary.base);
        setDailyCredits(summary.daily);
      }

      const { data: ledgerRows, error: ledgerErr } = await supabase
        .from("credit_ledger")
        .select("id, entry_type, source, amount, created_at, chat_id, chats(title)")
        .order("created_at", { ascending: false })
        .limit(30);
      if (ledgerErr) throw ledgerErr;
      setLedger((ledgerRows as LedgerEntry[]) ?? []);

      const { data: authData } = await supabase.auth.getUser();
      const user = authData.user;
      setIntegrationError(null);
      if (user) {
        setUserId(user.id);
        setProfileEmail(user.email ?? null);
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name, preferences")
          .eq("id", user.id)
          .maybeSingle();
        setProfileName(profile?.full_name ?? "");
        const prefs = (profile?.preferences ?? {}) as Record<string, unknown>;
        setBasePreferences(prefs);
        const rawSkills =
          typeof prefs.skills === "object" && prefs.skills !== null ? (prefs.skills as Record<string, unknown>) : {};
        const rawHf =
          typeof rawSkills.huggingface === "object" && rawSkills.huggingface !== null
            ? (rawSkills.huggingface as Record<string, unknown>)
            : {};
        setHuggingFaceSkills({
          search_hub: typeof rawHf.search_hub === "boolean" ? rawHf.search_hub : DEFAULT_HF_SKILLS.search_hub,
          explore_datasets:
            typeof rawHf.explore_datasets === "boolean"
              ? rawHf.explore_datasets
              : DEFAULT_HF_SKILLS.explore_datasets,
          query_dataset:
            typeof rawHf.query_dataset === "boolean" ? rawHf.query_dataset : DEFAULT_HF_SKILLS.query_dataset,
          get_documentation:
            typeof rawHf.get_documentation === "boolean"
              ? rawHf.get_documentation
              : DEFAULT_HF_SKILLS.get_documentation,
          run_spaces: typeof rawHf.run_spaces === "boolean" ? rawHf.run_spaces : DEFAULT_HF_SKILLS.run_spaces,
          train_model: typeof rawHf.train_model === "boolean" ? rawHf.train_model : DEFAULT_HF_SKILLS.train_model,
        });
        const commPrefs = isRecord(prefs.comm) ? prefs.comm : {};
        setSettingsEmailUpdates(
          typeof commPrefs.email_updates === "boolean" ? commPrefs.email_updates : true
        );
        setSettingsQueuedTasks(
          typeof commPrefs.queued_task_start === "boolean" ? commPrefs.queued_task_start : false
        );
        setNickname(typeof prefs.nickname === "string" ? prefs.nickname : "");
        setOccupation(typeof prefs.occupation === "string" ? prefs.occupation : "");
        setAbout(typeof prefs.about === "string" ? prefs.about : "");
        setInstructions(typeof prefs.instructions === "string" ? prefs.instructions : "");
        setGoal(parseGoal(prefs.goal));
        const mcpPref = readMcpEnabledServers(prefs);
        setMcpEnabledServers(mcpPref.enabledServers);
        const rawMcp = isRecord(prefs.mcp) ? (prefs.mcp as Record<string, unknown>) : null;
        setMcpExplicit(readMcpExplicitFlag(rawMcp));
        const prefMode = parseProjectMode(prefs.default_mode);
        if (prefMode) {
          setDefaultMode(prefMode);
          if (prefMode !== storedMode) {
            setStoredMode(prefMode);
          }
        } else {
          setDefaultMode(storedMode);
        }
        const loadProviderStatus = async (provider: IntegrationProvider): Promise<boolean> => {
          try {
            const response = await fetch(`/api/integrations/${provider}`, { method: "GET" });
            if (!response.ok) return false;
            const payload = (await response.json().catch(() => null)) as IntegrationStatusPayload | null;
            return Boolean(payload?.hasToken);
          } catch {
            return false;
          }
        };
        const [hfStatus, ghStatus, kgStatus, firecrawlStatus] = await Promise.all([
          loadProviderStatus("huggingface"),
          loadProviderStatus("github"),
          loadProviderStatus("kaggle"),
          loadProviderStatus("firecrawl"),
        ]);
        setHasHuggingFaceToken(hfStatus);
        setHasGithubToken(ghStatus);
        setHasKaggleToken(kgStatus);
        setHasFirecrawlToken(firecrawlStatus);
        const servers = await refreshMcpServers();
        if (!mcpPref.hasExplicitConfig && servers.length > 0) {
          const fallback = getDefaultMcpEnabledServers(servers.map((server) => server.id));
          if (!isSameServerSet(fallback, mcpPref.enabledServers)) {
            setMcpEnabledServers(fallback);
          }
        }
        setGithubReposLoading(true);
        try {
          const response = await fetch("/api/integrations/github/repos", { method: "GET" });
          if (!response.ok) {
            setGithubRepoConnections([]);
          } else {
            const payload = (await response.json().catch(() => null)) as
              | { repos?: GithubRepoConnection[] }
              | null;
            setGithubRepoConnections(Array.isArray(payload?.repos) ? payload.repos : []);
          }
        } catch {
          setGithubRepoConnections([]);
        } finally {
          setGithubReposLoading(false);
        }
      } else {
        setUserId(null);
        setProfileEmail(null);
        setHasHuggingFaceToken(false);
        setHasGithubToken(false);
        setHasKaggleToken(false);
        setHasFirecrawlToken(false);
        setHuggingFaceSkills(DEFAULT_HF_SKILLS);
        setMcpServers([]);
        setMcpEnabledServers([]);
        setMcpExplicit(false);
        setMcpError(null);
        setMcpLoading(false);
        setGithubRepoConnections([]);
        setGithubReposLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load credits");
    } finally {
      setLoading(false);
    }
  }, [refreshMcpServers, setStoredMode, storedMode, supabase]);

  useEffect(() => {
    if (!open) return;
    void loadData();
  }, [open, loadData]);

  useEffect(() => {
    if (!open) return;
    setActiveTab(initialIntegrationProvider ? "integrations" : initialTab);
    setProfileTab(initialProfileTab);
    setIntegrationFocusProvider(initialIntegrationProvider ?? null);
    setIntegrationModalOpen(Boolean(initialIntegrationProvider));
    setShowGithubRepoForm(false);
    setHuggingFaceSkillsExpanded(false);
    setMcpServersExpanded(false);
    setMcpFormError(null);
    setMcpFormNotice(null);
    setDeleteConfirmOpen(false);
    setDeleteAccountError(null);
  }, [initialIntegrationProvider, initialProfileTab, initialTab, open]);

  useEffect(() => {
    if (!copySuccess) return;
    const timer = window.setTimeout(() => setCopySuccess(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copySuccess]);

  useEffect(() => {
    if (integrationFocusProvider !== "github" && showGithubRepoForm) {
      setShowGithubRepoForm(false);
    }
  }, [integrationFocusProvider, showGithubRepoForm]);

  const copyUserId = useCallback(async () => {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setCopySuccess(true);
    } catch {
      // ignore
    }
  }, [userId]);

  const openIntegrationModal = useCallback((provider: IntegrationProvider) => {
    setIntegrationFocusProvider(provider);
    setIntegrationModalOpen(true);
    setShowGithubRepoForm(false);
  }, []);

  const closeIntegrationModal = useCallback(() => {
    setIntegrationModalOpen(false);
    setIntegrationFocusProvider(null);
    setShowGithubRepoForm(false);
  }, []);

  const buildPreferences = useCallback(
    () => {
      const normalizedMcpServers = Array.from(
        new Set(mcpEnabledServers.map((id) => id.trim()).filter(Boolean))
      );
      const filteredMcpServers =
        availableMcpIds.size > 0
          ? normalizedMcpServers.filter((id) => availableMcpIds.has(id))
          : normalizedMcpServers;
      return {
        ...basePreferences,
        nickname: normalizePrefString(nickname),
        occupation: normalizePrefString(occupation),
        about: normalizePrefString(about),
        instructions: normalizePrefString(instructions),
        goal: goal ?? null,
        default_mode: defaultMode ?? null,
        skills: {
          ...(isRecord(basePreferences.skills) ? basePreferences.skills : {}),
          huggingface: {
            ...huggingFaceSkills,
          },
        },
        mcp: {
          ...(isRecord(basePreferences.mcp) ? basePreferences.mcp : {}),
          enabled_servers: filteredMcpServers,
          explicit: mcpExplicit,
        },
        comm: {
          ...(isRecord(basePreferences.comm) ? basePreferences.comm : {}),
          email_updates: settingsEmailUpdates,
          queued_task_start: settingsQueuedTasks,
        },
      };
    },
    [
      about,
      basePreferences,
      defaultMode,
      goal,
      huggingFaceSkills,
      instructions,
      availableMcpIds,
      mcpEnabledServers,
      mcpExplicit,
      nickname,
      occupation,
      settingsEmailUpdates,
      settingsQueuedTasks,
    ]
  );

  const buildSkillsPreferences = useCallback(() => {
    const normalizedMcpServers = Array.from(new Set(mcpEnabledServers.map((id) => id.trim()).filter(Boolean)));
    const filteredMcpServers =
      availableMcpIds.size > 0
        ? normalizedMcpServers.filter((id) => availableMcpIds.has(id))
        : normalizedMcpServers;
    return {
      ...basePreferences,
      skills: {
        ...(isRecord(basePreferences.skills) ? basePreferences.skills : {}),
        huggingface: {
          ...huggingFaceSkills,
        },
      },
      mcp: {
        ...(isRecord(basePreferences.mcp) ? basePreferences.mcp : {}),
        enabled_servers: filteredMcpServers,
        explicit: mcpExplicit,
      },
    };
  }, [availableMcpIds, basePreferences, huggingFaceSkills, mcpEnabledServers, mcpExplicit]);

  const saveProfile = useCallback(async () => {
    if (!userId) return;
    setSavingProfile(true);
    try {
      const payload: Record<string, unknown> = { id: userId };
      if (profileName.trim()) payload.full_name = profileName.trim();
      await supabase.from("profiles").upsert(payload, { onConflict: "id" });
    } finally {
      setSavingProfile(false);
    }
  }, [profileName, supabase, userId]);

  const savePersonalization = useCallback(async () => {
    if (!userId) return;
    setSavingPersonalization(true);
    try {
      await supabase.from("profiles").upsert(
        {
          id: userId,
          preferences: buildPreferences(),
        },
        { onConflict: "id" }
      );
    } finally {
      setSavingPersonalization(false);
    }
  }, [buildPreferences, supabase, userId]);

  const saveControls = useCallback(async () => {
    if (!userId) return;
    setSavingControls(true);
    try {
      await supabase.from("profiles").upsert(
        {
          id: userId,
          preferences: buildPreferences(),
        },
        { onConflict: "id" }
      );
      setStoredMode(defaultMode);
    } finally {
      setSavingControls(false);
    }
  }, [buildPreferences, defaultMode, setStoredMode, supabase, userId]);

  const saveSettings = useCallback(async () => {
    if (!userId) return;
    setSavingSettings(true);
    try {
      await supabase.from("profiles").upsert(
        {
          id: userId,
          preferences: {
            ...basePreferences,
            comm: {
              ...(isRecord(basePreferences.comm) ? basePreferences.comm : {}),
              email_updates: settingsEmailUpdates,
              queued_task_start: settingsQueuedTasks,
            },
          },
        },
        { onConflict: "id" }
      );
    } finally {
      setSavingSettings(false);
    }
  }, [basePreferences, settingsEmailUpdates, settingsQueuedTasks, supabase, userId]);

  const toggleHuggingFaceSkill = useCallback((key: HuggingFaceSkillKey) => {
    setHuggingFaceSkills((prev) => ({ ...prev, [key]: !prev[key] }));
    setSkillsAutosaveNonce((prev) => prev + 1);
  }, []);

  const toggleHuggingFaceSkillsExpanded = useCallback(() => {
    setHuggingFaceSkillsExpanded((prev) => !prev);
  }, []);

  const toggleMcpServersExpanded = useCallback(() => {
    setMcpServersExpanded((prev) => !prev);
  }, []);

  const openMcpModal = useCallback(() => {
    setMcpFormError(null);
    setMcpModalOpen(true);
  }, []);

  const closeMcpModal = useCallback(() => {
    setMcpModalOpen(false);
    setMcpFormError(null);
  }, []);

  const toggleMcpServer = useCallback((serverId: string) => {
    const normalized = serverId.trim();
    if (!normalized) return;
    setMcpExplicit(true);
    setMcpEnabledServers((prev) =>
      prev.includes(normalized)
        ? prev.filter((id) => id !== normalized)
        : [...prev, normalized]
    );
    setSkillsAutosaveNonce((prev) => prev + 1);
  }, []);

  const submitMcpServer = useCallback(async () => {
    if (!userId) return;
    const label = mcpFormLabel.trim();
    const url = mcpFormUrl.trim();
    if (!label || !url) {
      setMcpFormError("Label and URL are required.");
      return;
    }
    const headerName = mcpFormHeaderName.trim();
    const headerValue = mcpFormHeaderValue.trim();
    if ((headerName && !headerValue) || (!headerName && headerValue)) {
      setMcpFormError("Header name and value must both be provided.");
      return;
    }
    setMcpSubmitting(true);
    setMcpFormError(null);
    setMcpFormNotice(null);
    try {
      const headers =
        headerName && headerValue
          ? { [headerName]: headerValue }
          : undefined;
      const response = await fetch("/api/mcp/user-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, url, headers }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : `Failed to add MCP server (${response.status})`;
        throw new Error(message);
      }
      setMcpFormLabel("");
      setMcpFormUrl("");
      setMcpFormHeaderName("");
      setMcpFormHeaderValue("");
      setMcpFormNotice("MCP server added.");
      setMcpModalOpen(false);
      await refreshMcpServers();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add MCP server.";
      setMcpFormError(message);
    } finally {
      setMcpSubmitting(false);
    }
  }, [
    mcpFormHeaderName,
    mcpFormHeaderValue,
    mcpFormLabel,
    mcpFormUrl,
    refreshMcpServers,
    userId,
  ]);

  const deleteMcpServer = useCallback(
    async (serverId: string) => {
      if (!userId) return;
      const normalized = serverId.trim();
      if (!normalized) return;
      setMcpDeletingId(normalized);
      try {
        const response = await fetch(`/api/mcp/user-servers/${normalized}`, { method: "DELETE" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message =
            typeof payload?.error === "string"
              ? payload.error
              : `Failed to delete MCP server (${response.status})`;
          throw new Error(message);
        }
        setMcpExplicit(true);
        setMcpEnabledServers((prev) => prev.filter((id) => id !== normalized));
        setSkillsAutosaveNonce((prev) => prev + 1);
        await refreshMcpServers();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete MCP server.";
        setMcpFormError(message);
      } finally {
        setMcpDeletingId(null);
      }
    },
    [refreshMcpServers, userId]
  );

  const saveSkills = useCallback(async () => {
    if (!userId) return;
    setSavingSkills(true);
    setSkillsError(null);
    setSkillsNotice(null);
    try {
      const nextPreferences = buildSkillsPreferences();
      await supabase.from("profiles").upsert(
        {
          id: userId,
          preferences: nextPreferences,
        },
        { onConflict: "id" }
      );
      setBasePreferences(nextPreferences);
      setSkillsNotice("Settings updated.");
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : "Failed to save skills.");
    } finally {
      setSavingSkills(false);
    }
  }, [buildSkillsPreferences, supabase, userId]);

  useEffect(() => {
    if (!skillsAutosaveNonce) return;
    if (!userId) return;
    if (skillsAutosaveTimeoutRef.current) clearTimeout(skillsAutosaveTimeoutRef.current);
    skillsAutosaveTimeoutRef.current = setTimeout(() => {
      void saveSkills();
    }, 450);

    return () => {
      if (skillsAutosaveTimeoutRef.current) clearTimeout(skillsAutosaveTimeoutRef.current);
    };
  }, [skillsAutosaveNonce, saveSkills, userId]);

  const saveIntegrationToken = useCallback(
    async (provider: IntegrationProvider) => {
      if (!userId) return;
      const token =
        provider === "huggingface"
          ? huggingFaceToken.trim()
          : provider === "github"
            ? githubToken.trim()
            : provider === "kaggle"
              ? kaggleToken.trim()
              : firecrawlToken.trim();
      if (!token) {
        setIntegrationError("Token is required.");
        setIntegrationNotice(null);
        return;
      }
      setIntegrationError(null);
      setIntegrationNotice(null);
      setSavingIntegration(provider);
      try {
        const response = await fetch(`/api/integrations/${provider}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const payload = (await response.json().catch(() => null)) as IntegrationStatusPayload | null;
        if (!response.ok) {
          throw new Error(
            typeof payload?.error === "string"
              ? payload.error
              : `Failed to save token (${response.status})`
          );
        }
        const hasToken = Boolean(payload?.hasToken);
        if (provider === "huggingface") {
          setHasHuggingFaceToken(hasToken);
          setHuggingFaceToken("");
          setIntegrationNotice("Hugging Face token saved.");
        } else if (provider === "github") {
          setHasGithubToken(hasToken);
          setGithubToken("");
          setIntegrationNotice("GitHub token saved.");
        } else if (provider === "kaggle") {
          setHasKaggleToken(hasToken);
          setKaggleToken("");
          setIntegrationNotice("Kaggle token saved.");
        } else {
          setHasFirecrawlToken(hasToken);
          setFirecrawlToken("");
          setIntegrationNotice("Firecrawl API key saved.");
        }
      } catch (err) {
        setIntegrationError(err instanceof Error ? err.message : "Failed to save token.");
      } finally {
        setSavingIntegration(null);
      }
    },
    [firecrawlToken, githubToken, huggingFaceToken, kaggleToken, userId]
  );

  const deleteIntegration = useCallback(
    async (provider: IntegrationProvider) => {
      if (!userId) return;
      setIntegrationError(null);
      setIntegrationNotice(null);
      setRemovingIntegration(provider);
      try {
        const response = await fetch(`/api/integrations/${provider}`, { method: "DELETE" });
        const payload = (await response.json().catch(() => null)) as IntegrationStatusPayload | null;
        if (!response.ok) {
          throw new Error(
            typeof payload?.error === "string"
              ? payload.error
              : `Failed to remove token (${response.status})`
          );
        }
        if (provider === "huggingface") {
          setHasHuggingFaceToken(false);
          setHuggingFaceToken("");
          setIntegrationNotice("Hugging Face token removed.");
        } else if (provider === "github") {
          setHasGithubToken(false);
          setGithubToken("");
          setIntegrationNotice("GitHub token removed.");
        } else if (provider === "kaggle") {
          setHasKaggleToken(false);
          setKaggleToken("");
          setIntegrationNotice("Kaggle token removed.");
        } else {
          setHasFirecrawlToken(false);
          setFirecrawlToken("");
          setIntegrationNotice("Firecrawl API key removed.");
        }
      } catch (err) {
        setIntegrationError(err instanceof Error ? err.message : "Failed to remove token.");
      } finally {
        setRemovingIntegration(null);
      }
    },
    [userId]
  );

  const saveGithubRepoConnection = useCallback(async () => {
    if (!userId) return;
    const repoFullName = githubRepoFullName.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
      setIntegrationError("GitHub repo must be in owner/repo format.");
      setIntegrationNotice(null);
      return;
    }

    setSavingGithubRepo(true);
    setIntegrationError(null);
    setIntegrationNotice(null);
    try {
      const response = await fetch("/api/integrations/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoFullName,
          isPrivate: githubRepoPrivate,
          baseBranch: githubRepoBaseBranch.trim() || "main",
          workBranch: githubRepoWorkBranch.trim() || "tuna",
          defaultPublishMode: githubRepoPublishMode,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; repo?: GithubRepoConnection }
        | null;
      if (!response.ok || !payload?.repo) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : `Failed to save GitHub repo (${response.status})`
        );
      }
      setGithubRepoConnections((prev) => {
        const next = [payload.repo as GithubRepoConnection, ...prev.filter((item) => item.id !== payload.repo!.id)];
        return next;
      });
      setGithubRepoFullName("");
      setGithubRepoPrivate(false);
      setGithubRepoBaseBranch("main");
      setGithubRepoWorkBranch("tuna");
      setGithubRepoPublishMode("pr");
      setIntegrationNotice("GitHub repo connected.");
    } catch (err) {
      setIntegrationError(err instanceof Error ? err.message : "Failed to save GitHub repo.");
    } finally {
      setSavingGithubRepo(false);
    }
  }, [
    githubRepoBaseBranch,
    githubRepoFullName,
    githubRepoPrivate,
    githubRepoPublishMode,
    githubRepoWorkBranch,
    userId,
  ]);

  const removeGithubRepoConnection = useCallback(async (connectionId: string) => {
    if (!userId) return;
    setRemovingGithubRepoId(connectionId);
    setIntegrationError(null);
    setIntegrationNotice(null);
    try {
      const response = await fetch(`/api/integrations/github/repos/${connectionId}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : `Failed to remove GitHub repo (${response.status})`
        );
      }
      setGithubRepoConnections((prev) => prev.filter((item) => item.id !== connectionId));
      setIntegrationNotice("GitHub repo disconnected.");
    } catch (err) {
      setIntegrationError(err instanceof Error ? err.message : "Failed to remove GitHub repo.");
    } finally {
      setRemovingGithubRepoId(null);
    }
  }, [userId]);

  const requestDeleteAccount = useCallback(() => {
    setDeleteAccountError(null);
    setDeleteConfirmOpen(true);
  }, []);

  const cancelDeleteAccount = useCallback(() => {
    if (deletingAccount) return;
    setDeleteAccountError(null);
    setDeleteConfirmOpen(false);
  }, [deletingAccount]);

  const confirmDeleteAccount = useCallback(async () => {
    if (deletingAccount) return;
    setDeletingAccount(true);
    setDeleteAccountError(null);
    try {
      const response = await fetch("/api/account/delete", { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message =
          typeof payload?.error === "string" ? payload.error : `Failed to delete account (${response.status})`;
        throw new Error(message);
      }
      await supabase.auth.signOut();
      onClose();
      router.push("/login");
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete account.";
      setDeleteAccountError(message);
    } finally {
      setDeletingAccount(false);
    }
  }, [deletingAccount, onClose, router, supabase]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  const navItems: Array<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
    { id: "account", label: "Account", icon: User },
    { id: "settings", label: "Settings", icon: Settings },
    { id: "usage", label: "Usage", icon: Sparkles },
    { id: "controls", label: "Agent controls", icon: Settings },
    { id: "personalization", label: "Personalization", icon: Palette },
    { id: "skills", label: "Skills", icon: Wrench },
    { id: "integrations", label: "Integrations", icon: Link2 },
  ];

  const activeLabel = navItems.find((item) => item.id === activeTab)?.label ?? "Usage";
  const title = activeLabel;
  const displayName = (profileName && profileName.trim()) || profileEmail || "Account";
  const initials = getInitials(displayName);
  const displayLedger = useMemo(() => {
    if (ledger.length === 0) return [];
    const grouped = new Map<string, LedgerSummary>();
    const loose: LedgerSummary[] = [];

    for (const entry of ledger) {
      const amount = parseSignedCredits(entry.amount);
      const createdAt = entry.created_at ? new Date(entry.created_at).getTime() : 0;

      if (!entry.chat_id) {
        loose.push({ ...entry, amount, _latestTimestamp: createdAt });
        continue;
      }

      const key = entry.chat_id;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          ...entry,
          id: `chat:${entry.chat_id}`,
          amount,
          created_at: entry.created_at ?? null,
          _latestTimestamp: createdAt,
        });
        continue;
      }

      existing.amount += amount;
      if (createdAt >= existing._latestTimestamp) {
        existing._latestTimestamp = createdAt;
        existing.created_at = entry.created_at ?? existing.created_at;
        existing.entry_type = entry.entry_type ?? existing.entry_type;
      }

      const existingTitle = Array.isArray(existing.chats)
        ? existing.chats[0]?.title ?? ""
        : existing.chats?.title ?? "";
      const nextTitle = Array.isArray(entry.chats) ? entry.chats[0]?.title ?? "" : entry.chats?.title ?? "";
      if (!existingTitle && nextTitle) {
        existing.chats = entry.chats;
      }

      if (existing.source && entry.source && existing.source !== entry.source) {
        existing.source = null;
      } else if (!existing.source && entry.source) {
        existing.source = entry.source;
      }
    }

    const combined = [...grouped.values(), ...loose];
    combined.sort((a, b) => b._latestTimestamp - a._latestTimestamp);
    return combined;
  }, [ledger]);

  const canManageSkills = Boolean(userId);
  const canManageIntegrations = Boolean(userId);
  const integrationState: Record<
    IntegrationProvider,
    {
      hasToken: boolean;
      token: string;
      setToken: (value: string) => void;
      saving: boolean;
      removing: boolean;
    }
  > = {
    github: {
      hasToken: hasGithubToken,
      token: githubToken,
      setToken: (value) => setGithubToken(value),
      saving: savingIntegration === "github",
      removing: removingIntegration === "github",
    },
    huggingface: {
      hasToken: hasHuggingFaceToken,
      token: huggingFaceToken,
      setToken: (value) => setHuggingFaceToken(value),
      saving: savingIntegration === "huggingface",
      removing: removingIntegration === "huggingface",
    },
    kaggle: {
      hasToken: hasKaggleToken,
      token: kaggleToken,
      setToken: (value) => setKaggleToken(value),
      saving: savingIntegration === "kaggle",
      removing: removingIntegration === "kaggle",
    },
    firecrawl: {
      hasToken: hasFirecrawlToken,
      token: firecrawlToken,
      setToken: (value) => setFirecrawlToken(value),
      saving: savingIntegration === "firecrawl",
      removing: removingIntegration === "firecrawl",
    },
  };

  const modalProvider = integrationModalOpen ? integrationFocusProvider : null;
  const modalMeta = modalProvider ? integrationCatalog[modalProvider] : null;
  const modalState = modalProvider ? integrationState[modalProvider] : null;
  const modalLogo = modalMeta?.logo;
  const ModalLogo = modalLogo ?? null;
  const modalTokenPlaceholder =
    modalState && modalMeta
      ? modalState.hasToken
        ? modalMeta.tokenRotatePlaceholder
        : modalMeta.tokenPlaceholder
      : "";
  const modalCanRemove =
    Boolean(modalState && modalState.hasToken && !modalState.removing && !modalState.saving) && canManageIntegrations;
  const modalCanSave =
    Boolean(modalState && modalState.token.trim()) && !modalState?.saving && !modalState?.removing && canManageIntegrations;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="credits-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: [0.19, 1, 0.22, 1] }}
          className={cn(
            "fixed inset-0 z-[100] flex items-start justify-center p-0 sm:p-6",
            isDark ? "bg-black/60" : "bg-black/20",
            "backdrop-blur-sm"
          )}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.19, 1, 0.22, 1] }}
            className="w-full max-w-[880px] overflow-hidden flex flex-col bg-elevated text-primary shadow-black/25 h-dvh rounded-none border-0 sm:mt-[8vh] sm:h-[82dvh] sm:rounded-2xl sm:border sm:border-default sm:shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
              <aside className="hidden sm:block w-[240px] shrink-0 border-r border-default px-4 py-4 overflow-y-auto min-h-0 bg-secondary">
                <div className="px-2 pb-3 flex items-center text-sm font-semibold tracking-tight">
                  <span>Settings</span>
                </div>
                <nav className="space-y-1">
                  {navItems.map((item) => {
                    const active = item.id === activeTab;
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setActiveTab(item.id)}
                        className={cn(
                          "w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                          active ? "bg-tertiary text-primary" : "text-secondary hover:bg-tertiary"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </nav>
              </aside>

              <section className="flex-1 min-w-0 flex flex-col min-h-0">
                <div className="border-b border-default px-4 sm:px-6 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[18px] font-semibold tracking-tight truncate">{title}</div>
                    </div>
                    <button
                      type="button"
                      onClick={onClose}
                      aria-label="Close"
                      className="p-2 rounded-full transition-colors text-muted hover:text-primary hover:bg-tertiary"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="mt-3 -mx-2 sm:hidden">
                    <div className="flex items-center gap-1.5 overflow-x-auto px-2 pb-1 scrollbar-hide">
                      {navItems.map((item) => {
                        const active = item.id === activeTab;
                        const Icon = item.icon;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setActiveTab(item.id)}
                            className={cn(
                              "shrink-0 inline-flex items-center gap-2 rounded-full border border-default px-3 py-1.5 text-[12px] font-medium transition-colors",
                              active ? "bg-tertiary text-primary" : "bg-transparent text-secondary hover:bg-tertiary"
                            )}
                          >
                            <Icon className="h-3.5 w-3.5" />
                            <span className="whitespace-nowrap">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] sm:pb-5 overflow-y-auto flex-1 min-h-0">
                  {activeTab === "usage" ? (
                    <div className="space-y-4">
                      <div
                        className={cn(
                          "rounded-2xl border px-4 py-4",
                          isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-white"
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div className="text-base font-semibold">Free</div>
                        </div>
                        <div className={cn("mt-3 divide-y", isDark ? "divide-white/10" : "divide-black/10")}>
                          <div className="flex items-center justify-between py-3 text-sm">
                            <div className="flex items-center gap-2">
                              <Sparkles className="h-4 w-4" />
                              <div>
                                <div className="font-medium">Credits</div>
                              </div>
                            </div>
                            <div className="font-semibold">
                              {loading ? "…" : formatCredits(balance)}
                            </div>
                          </div>
                          <div className="flex items-center justify-between py-3 text-sm">
                            <div className="flex items-center gap-2">
                              <Calendar className="h-4 w-4" />
                              <div>
                                <div className="font-medium">Daily refresh credits</div>
                              </div>
                            </div>
                            <div className="font-semibold">{loading ? "…" : formatCredits(dailyCredits)}</div>
                          </div>
                        </div>
                      </div>

                      <div
                        className={cn(
                          "rounded-2xl border px-4 py-3",
                          isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-white"
                        )}
                      >
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div className={cn("text-sm font-semibold", isDark ? "text-white" : "text-zinc-900")}>
                            Activity
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              router.push("/settings/usage");
                            }}
                            className={cn(
                              "text-xs underline underline-offset-2",
                              isDark ? "text-white/70 hover:text-white" : "text-black/60 hover:text-black"
                            )}
                          >
                            View all
                          </button>
                        </div>
                        <div className="flex items-center justify-between text-xs uppercase tracking-wide text-black/50 dark:text-white/50">
                          <span>Details</span>
                          <span>Date</span>
                          <span>Credits change</span>
                        </div>
                        <div className={cn("mt-2 divide-y", isDark ? "divide-white/10" : "divide-black/10")}>
                          {error ? (
                            <div className="py-4 text-sm text-red-500">{error}</div>
                          ) : displayLedger.length > 0 ? (
                            displayLedger.map((entry) => {
                              const amount = parseSignedCredits(entry.amount);
                              const isNegative = amount < 0 || entry.entry_type === "usage" || entry.entry_type === "expire";
                              const chatTitle = Array.isArray(entry.chats)
                                ? entry.chats[0]?.title ?? ""
                                : entry.chats?.title ?? "";
                              const typeLabel =
                                entry.entry_type === "usage"
                                  ? "Usage"
                                  : entry.entry_type === "grant"
                                    ? "Grant"
                                    : entry.entry_type === "refund"
                                      ? "Refund"
                                      : entry.entry_type === "adjustment"
                                        ? "Adjustment"
                                        : entry.entry_type === "expire"
                                          ? "Expiration"
                                          : entry.entry_type;
                              const labelParts = [
                                typeLabel,
                                entry.source ? `(${entry.source})` : "",
                              ].filter(Boolean);
                              const detail = chatTitle || labelParts.join(" ");
                              return (
                                <div key={entry.id} className="flex items-center justify-between py-3 text-sm">
                                  <div className="min-w-0 flex-1 pr-4 font-medium truncate">
                                    {entry.chat_id && chatTitle ? (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          onClose();
                                          router.push(`/${entry.chat_id}`);
                                        }}
                                        className={cn(
                                          "truncate text-left hover:underline",
                                          isDark ? "text-white" : "text-zinc-900"
                                        )}
                                      >
                                        {detail}
                                      </button>
                                    ) : (
                                      detail
                                    )}
                                  </div>
                                  <div className={cn("min-w-[140px] text-xs", isDark ? "text-white/60" : "text-black/50")}>
                                    {formatTimestamp(entry.created_at)}
                                  </div>
                                  <div className={cn("min-w-[90px] text-right font-semibold", isNegative ? "text-red-500" : "text-emerald-500")}>
                                    {isNegative ? "-" : "+"}
                                    {formatCredits(Math.abs(amount))}
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className={cn("py-4 text-sm", isDark ? "text-white/60" : "text-black/50")}>
                              No activity yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : activeTab === "account" ? (
                    <div className="space-y-6">
                      <div className="text-sm font-semibold">Profile</div>
                      <div className="flex items-center gap-4">
                        <div
                          className={cn(
                            "h-16 w-16 rounded-full flex items-center justify-center text-lg font-semibold",
                            isDark ? "bg-white/10 text-white" : "bg-black/5 text-zinc-900"
                          )}
                        >
                          {initials}
                        </div>
                        <div className="flex-1">
                          <label className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>
                            Name
                          </label>
                          <input
                            value={profileName}
                            onChange={(e) => setProfileName(e.target.value)}
                            placeholder="Your name"
                            className={cn(
                              "mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                              isDark
                                ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                : "border-black/10 bg-white text-black focus:border-black/30"
                            )}
                          />
                        </div>
                      </div>

                      <div>
                        <div className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>Email</div>
                        <div className="mt-1 text-sm">{profileEmail ?? "—"}</div>
                      </div>

                      <div>
                        <div className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>User ID</div>
                        <div className="mt-1 flex items-center gap-2 text-sm">
                          <span className="truncate">{userId ?? "—"}</span>
                          {userId ? (
                            <button
                              type="button"
                              onClick={copyUserId}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                                isDark
                                  ? "bg-white/10 text-white hover:bg-white/20"
                                  : "bg-black/5 text-black hover:bg-black/10"
                              )}
                            >
                              {copySuccess ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                              {copySuccess ? "Copied" : "Copy"}
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={saveProfile}
                          disabled={!userId || savingProfile}
                          className={cn(
                            "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                            isDark
                              ? "bg-white/10 text-white hover:bg-white/20"
                              : "bg-black text-white hover:bg-black/90"
                          )}
                        >
                          {savingProfile ? "Saving…" : "Save"}
                        </button>
                      </div>

                      <div className={cn("pt-4 border-t", isDark ? "border-white/10" : "border-black/10")}>
                        <div className="text-sm font-semibold">Delete account</div>
                        <div className={cn("mt-1 text-xs", isDark ? "text-white/50" : "text-black/50")}>
                          This will delete your account and all data.
                        </div>
                        <button
                          type="button"
                          onClick={requestDeleteAccount}
                          className={cn(
                            "mt-3 rounded-full border px-4 py-2 text-xs font-semibold transition-colors",
                            isDark
                              ? "border-white/20 text-white/80 hover:text-white hover:border-white/40"
                              : "border-red-300 text-red-600 hover:border-red-400"
                          )}
                        >
                          Delete account
                        </button>
                        {deleteConfirmOpen && (
                          <div
                            className={cn(
                              "mt-4 rounded-2xl border px-4 py-4 text-sm",
                              isDark
                                ? "border-white/10 bg-white/5 text-white/70"
                                : "border-black/10 bg-black/5 text-black/70"
                            )}
                          >
                            <div className="font-medium text-sm text-inherit">Confirm deletion</div>
                            <div className={cn("mt-1 text-xs", isDark ? "text-white/50" : "text-black/50")}>
                              This cannot be undone. You’ll be signed out immediately.
                            </div>
                            {deleteAccountError && (
                              <div className={cn("mt-2 text-xs", isDark ? "text-red-300" : "text-red-600")}>
                                {deleteAccountError}
                              </div>
                            )}
                            <div className="mt-4 flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={cancelDeleteAccount}
                                disabled={deletingAccount}
                                className={cn(
                                  "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                                  isDark
                                    ? "bg-white/10 text-white hover:bg-white/20"
                                    : "bg-black/5 text-black hover:bg-black/10"
                                )}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={confirmDeleteAccount}
                                disabled={deletingAccount}
                                className={cn(
                                  "rounded-full px-4 py-2 text-xs font-semibold text-white transition-opacity disabled:opacity-60",
                                  "bg-red-500 hover:bg-red-600"
                                )}
                              >
                                {deletingAccount ? "Deleting…" : "Delete account"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : activeTab === "settings" ? (
                    <div className="space-y-6">
                      <div>
                        <div className="text-sm font-semibold">General</div>
                        <div className="mt-3">
                          <div className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>Language</div>
                          <div
                            className={cn(
                              "mt-2 inline-flex items-center rounded-lg border px-3 py-2 text-sm",
                              isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-white"
                            )}
                          >
                            English
                          </div>
                        </div>
                      </div>

                      <div>
                        <div className="text-sm font-semibold">Appearance</div>
                        <div className="mt-3 flex flex-wrap gap-3">
                          {(["light", "dark", "system"] as const).map((mode) => {
                            const active = themePreference === mode;
                            const label = mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System";
                            return (
                              <button
                                key={mode}
                                type="button"
                                aria-pressed={active}
                                onClick={() => onThemeChange?.(mode)}
                                className={cn(
                                  "w-28 rounded-xl border px-3 py-3 text-xs font-semibold transition-colors",
                                  active
                                    ? "border-focus bg-elevated text-primary"
                                    : "border-default bg-transparent text-secondary hover:bg-tertiary"
                                )}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm font-semibold">Communication preferences</div>
                        <div className="mt-3 space-y-3 text-sm">
                          <label className="flex items-center justify-between gap-4">
                            <div>
                              <div className="font-medium">Receive exclusive content</div>
                              <div className={cn("text-xs", isDark ? "text-white/50" : "text-black/50")}>
                                Get updates, guides, and new feature notes.
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setSettingsEmailUpdates((prev) => !prev)}
                              className={cn(
                                "h-5 w-9 rounded-full transition-colors",
                                settingsEmailUpdates
                                  ? "bg-emerald-500"
                                  : isDark
                                    ? "bg-white/10"
                                    : "bg-black/10"
                              )}
                            >
                              <span
                                className={cn(
                                  "block h-4 w-4 rounded-full bg-white transition-transform",
                                  settingsEmailUpdates ? "translate-x-4" : "translate-x-1"
                                )}
                              />
                            </button>
                          </label>

                          <label className="flex items-center justify-between gap-4">
                            <div>
                              <div className="font-medium">Email when queued tasks start</div>
                              <div className={cn("text-xs", isDark ? "text-white/50" : "text-black/50")}>
                                We’ll let you know when processing begins.
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setSettingsQueuedTasks((prev) => !prev)}
                              className={cn(
                                "h-5 w-9 rounded-full transition-colors",
                                settingsQueuedTasks
                                  ? "bg-emerald-500"
                                  : isDark
                                    ? "bg-white/10"
                                    : "bg-black/10"
                              )}
                            >
                              <span
                                className={cn(
                                  "block h-4 w-4 rounded-full bg-white transition-transform",
                                  settingsQueuedTasks ? "translate-x-4" : "translate-x-1"
                                )}
                              />
                            </button>
                          </label>
                        </div>
                        <div className="mt-4 flex justify-end">
                          <button
                            type="button"
                            onClick={saveSettings}
                            disabled={!userId || savingSettings}
                            className={cn(
                              "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                              isDark
                                ? "bg-white/10 text-white hover:bg-white/20"
                                : "bg-black text-white hover:bg-black/90"
                            )}
                          >
                            {savingSettings ? "Saving…" : "Save"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : activeTab === "personalization" ? (
                    <div className="space-y-4">
                      <div className="flex items-center gap-4 border-b border-black/10 dark:border-white/10 pb-2">
                        <button
                          type="button"
                          onClick={() => setProfileTab("profile")}
                          className={cn(
                            "text-sm font-medium",
                            profileTab === "profile"
                              ? isDark
                                ? "text-white"
                                : "text-black"
                              : isDark
                                ? "text-white/50"
                                : "text-black/50"
                          )}
                        >
                          Profile
                        </button>
                        <button
                          type="button"
                          onClick={() => setProfileTab("knowledge")}
                          className={cn(
                            "text-sm font-medium",
                            profileTab === "knowledge"
                              ? isDark
                                ? "text-white"
                                : "text-black"
                              : isDark
                                ? "text-white/50"
                                : "text-black/50"
                          )}
                        >
                          Knowledge
                        </button>
                      </div>

                      {profileTab === "profile" ? (
                        <div className="space-y-4">
                          <div>
                            <label className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>Name</label>
                            <input
                              value={profileName}
                              readOnly
                              aria-readonly="true"
                              placeholder="Add your name in Account"
                              className={cn(
                                "mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                "cursor-default",
                                isDark
                                  ? "border-white/10 bg-white/5 text-white/80"
                                  : "border-black/10 bg-white text-black/70"
                              )}
                            />
                            <div className={cn("mt-1 text-[11px]", isDark ? "text-white/45" : "text-black/45")}>
                              Edit your name in Account.
                            </div>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div>
                              <label className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>
                                Nickname
                              </label>
                              <input
                                value={nickname}
                                onChange={(e) => setNickname(e.target.value)}
                                placeholder="What should we call you?"
                                className={cn(
                                  "mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                  isDark
                                    ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                    : "border-black/10 bg-white text-black focus:border-black/30"
                                )}
                              />
                            </div>
                            <div>
                              <label className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>
                                Occupation
                              </label>
                              <input
                                value={occupation}
                                onChange={(e) => setOccupation(e.target.value)}
                                placeholder="e.g., Product Designer"
                                className={cn(
                                  "mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                  isDark
                                    ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                    : "border-black/10 bg-white text-black focus:border-black/30"
                                )}
                              />
                            </div>
                          </div>
                          <div>
                            <label className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>
                              More about you
                            </label>
                            <textarea
                              value={about}
                              onChange={(e) => setAbout(e.target.value)}
                              placeholder="Background, preferences, or context"
                              rows={3}
                              className={cn(
                                "mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                isDark
                                  ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                  : "border-black/10 bg-white text-black focus:border-black/30"
                              )}
                            />
                          </div>
                          <div>
                            <label className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>
                              Custom instructions
                            </label>
                            <textarea
                              value={instructions}
                              onChange={(e) => setInstructions(e.target.value)}
                              placeholder="How should Tuna respond?"
                              rows={3}
                              className={cn(
                                "mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                isDark
                                  ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                  : "border-black/10 bg-white text-black focus:border-black/30"
                              )}
                            />
                          </div>
                          <div>
                            <div className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>
                              What are you here to do first?
                            </div>
                            <div className="mt-2 grid gap-3 sm:grid-cols-2">
                              {goalOptions.map((option) => {
                                const selected = goal === option.id;
                                const Icon = option.icon;
                                return (
                                  <button
                                    key={option.id}
                                    type="button"
                                    onClick={() => setGoal(option.id)}
                                    className={cn(
                                      "rounded-xl border px-3 py-3 text-left transition-colors overflow-hidden min-h-[96px] max-h-[96px]",
                                      selected
                                        ? isDark
                                          ? "border-white/40 bg-white/10 text-white"
                                          : "border-black/30 bg-black/5 text-black"
                                        : isDark
                                          ? "border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
                                          : "border-black/10 bg-white text-black/70 hover:bg-black/5"
                                    )}
                                  >
                                    <div className="flex items-start gap-2">
                                      <div
                                        className={cn(
                                          "mt-0.5 rounded-md p-1.5",
                                          selected
                                            ? isDark
                                              ? "bg-white/15"
                                              : "bg-black/5"
                                            : isDark
                                              ? "bg-white/10"
                                              : "bg-black/5"
                                        )}
                                      >
                                        <Icon className="h-4 w-4" />
                                      </div>
                                      <div className="min-w-0">
                                        <div className="text-sm font-medium line-clamp-1">{option.title}</div>
                                        <div className={cn("mt-1 text-xs line-clamp-2", isDark ? "text-white/50" : "text-black/50")}>
                                          {option.description}
                                        </div>
                                      </div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={savePersonalization}
                              disabled={!userId || savingPersonalization}
                              className={cn(
                                "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                                isDark
                                  ? "bg-white/10 text-white hover:bg-white/20"
                                  : "bg-black text-white hover:bg-black/90"
                              )}
                            >
                              {savingPersonalization ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "rounded-2xl border px-4 py-6 text-sm",
                            isDark
                              ? "border-white/10 bg-white/5 text-white/70"
                              : "border-black/10 bg-white text-black/60"
                          )}
                        >
                          No knowledge yet.
                        </div>
                      )}
                    </div>
                  ) : activeTab === "skills" ? (
                    <div className="space-y-4">
                      {skillsError ? (
                        <div
                          className={cn(
                            "rounded-xl border px-3 py-2 text-xs",
                            isDark ? "border-red-400/30 bg-red-500/10 text-red-200" : "border-red-300 bg-red-50 text-red-700"
                          )}
                        >
                          {skillsError}
                        </div>
                      ) : null}
                      {skillsNotice ? (
                        <div
                          className={cn(
                            "rounded-xl border px-3 py-2 text-xs",
                            isDark
                              ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                              : "border-emerald-300 bg-emerald-50 text-emerald-700"
                          )}
                        >
                          {skillsNotice}
                        </div>
                      ) : null}
                      <div
                        className={cn(
                          "rounded-2xl border px-4 py-4",
                          isDark ? "border-white/10 bg-white/5 text-white" : "border-black/10 bg-white text-black"
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                "h-10 w-10 rounded-2xl border flex items-center justify-center",
                                isDark ? "border-white/10 bg-white/5 text-white" : "border-black/10 bg-white text-black"
                              )}
                            >
                              <HuggingFaceLogo className="h-5 w-5" />
                            </div>
                            <div>
                              <div className="text-sm font-semibold">Hugging Face</div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={toggleHuggingFaceSkillsExpanded}
                            className={cn(
                              "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                              isDark
                                ? "bg-white/10 text-white hover:bg-white/20"
                                : "bg-black/5 text-black hover:bg-black/10"
                            )}
                          >
                            {huggingFaceSkillsExpanded ? "Close" : "Manage"}
                          </button>
                        </div>
                        {huggingFaceSkillsExpanded ? (
                          <div className="mt-4 space-y-3">
                            {huggingFaceSkillOptions.map((option) => {
                              const enabled = huggingFaceSkills[option.id];
                              return (
                                <label key={option.id} className="flex items-center justify-between gap-4">
                                  <div>
                                    <div className="text-sm font-medium">{option.title}</div>
                                    <div className={cn("mt-0.5 text-xs", isDark ? "text-white/50" : "text-black/50")}>
                                      {option.description}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => toggleHuggingFaceSkill(option.id)}
                                    disabled={!canManageSkills}
                                    className={cn(
                                      "h-5 w-9 rounded-full transition-colors disabled:opacity-60",
                                      enabled
                                        ? "bg-emerald-500"
                                        : isDark
                                          ? "bg-white/10"
                                          : "bg-black/10"
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        "block h-4 w-4 rounded-full bg-white transition-transform",
                                        enabled ? "translate-x-4" : "translate-x-1"
                                      )}
                                    />
                                  </button>
                                </label>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                      <div
                        className={cn(
                          "rounded-2xl border px-4 py-4",
                          isDark ? "border-white/10 bg-white/5 text-white" : "border-black/10 bg-white text-black"
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                "h-10 w-10 rounded-2xl border flex items-center justify-center",
                                isDark ? "border-white/10 bg-white/5 text-white" : "border-black/10 bg-white text-black"
                              )}
                            >
                              <McpLogo className="h-5 w-5" isDark={isDark} />
                            </div>
                            <div>
                              <div className="text-sm font-semibold">MCP servers</div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={toggleMcpServersExpanded}
                            className={cn(
                              "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                              isDark
                                ? "bg-white/10 text-white hover:bg-white/20"
                                : "bg-black/5 text-black hover:bg-black/10"
                            )}
                          >
                            {mcpServersExpanded ? "Close" : "Manage"}
                          </button>
                        </div>
                        {mcpServersExpanded ? (
                          <div className="mt-4 space-y-3">
                            {mcpFormNotice ? (
                              <div
                                className={cn(
                                  "rounded-xl border px-3 py-2 text-xs",
                                  isDark
                                    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                                    : "border-emerald-300 bg-emerald-50 text-emerald-700"
                                )}
                              >
                                {mcpFormNotice}
                              </div>
                            ) : null}
                            <div className="flex items-center gap-3">
                              <div className={cn("text-xs font-semibold", isDark ? "text-white/70" : "text-black/60")}>
                                Servers
                              </div>
                            </div>
                            {mcpError ? (
                              <div
                                className={cn(
                                  "rounded-xl border px-3 py-2 text-xs",
                                  isDark
                                    ? "border-red-400/30 bg-red-500/10 text-red-200"
                                    : "border-red-300 bg-red-50 text-red-700"
                                )}
                              >
                                {mcpError}
                              </div>
                            ) : null}
                            {mcpLoading ? (
                              <div className={cn("text-xs", isDark ? "text-white/50" : "text-black/50")}>
                                Loading MCP servers…
                              </div>
                            ) : mcpServers.length === 0 ? (
                              <div className={cn("text-xs", isDark ? "text-white/50" : "text-black/50")}>
                                No MCP servers are configured for this workspace.
                              </div>
                            ) : (
                              <div className="space-y-3">
                                {mcpServers.map((server) => {
                                  const enabled = mcpEnabledServers.includes(server.id);
                                  const isUserServer = server.origin === "user";
                                  const isFirecrawl = server.id === "firecrawl-mcp";
                                  const displayLabel = isFirecrawl ? "Firecrawl MCP" : server.label;
                                  const detailParts = isFirecrawl
                                    ? [server.toolCount !== undefined ? `${server.toolCount} tools` : null].filter(
                                        Boolean
                                      )
                                    : [
                                        server.transport === "stdio" ? "Local (stdio)" : "Remote (HTTP)",
                                        isUserServer ? "User" : "Managed",
                                        server.toolCount !== undefined ? `${server.toolCount} tools` : `id: ${server.id}`,
                                      ];
                                  return (
                                    <div key={server.id} className="flex items-center justify-between gap-4">
                                      <div>
                                        <div className="flex flex-wrap items-center gap-2">
                                          <div className="text-sm font-medium">{displayLabel}</div>
                                          {isFirecrawl ? (
                                            <span
                                              className={cn(
                                                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                                isDark
                                                  ? "bg-emerald-500/20 text-emerald-200"
                                                  : "bg-emerald-100 text-emerald-700"
                                              )}
                                            >
                                              Default
                                            </span>
                                          ) : null}
                                        </div>
                                        {detailParts.length ? (
                                          <div className={cn("mt-0.5 text-xs", isDark ? "text-white/50" : "text-black/50")}>
                                            {detailParts.join(" · ")}
                                          </div>
                                        ) : null}
                                      </div>
                                      <div className="flex items-center gap-2">
                                        {isUserServer ? (
                                          <button
                                            type="button"
                                            onClick={() => deleteMcpServer(server.id)}
                                            disabled={!canManageSkills || mcpDeletingId === server.id}
                                            className={cn(
                                              "rounded-full px-3 py-1.5 text-[11px] font-semibold transition-opacity disabled:opacity-60",
                                              isDark
                                                ? "bg-white/10 text-white hover:bg-white/20"
                                                : "bg-black/5 text-black hover:bg-black/10"
                                            )}
                                          >
                                            {mcpDeletingId === server.id ? "Removing..." : "Delete"}
                                          </button>
                                        ) : null}
                                        <button
                                          type="button"
                                          onClick={() => toggleMcpServer(server.id)}
                                          disabled={!canManageSkills}
                                          className={cn(
                                            "h-5 w-9 rounded-full transition-colors disabled:opacity-60",
                                            enabled
                                              ? "bg-emerald-500"
                                              : isDark
                                                ? "bg-white/10"
                                                : "bg-black/10"
                                          )}
                                        >
                                          <span
                                            className={cn(
                                              "block h-4 w-4 rounded-full bg-white transition-transform",
                                              enabled ? "translate-x-4" : "translate-x-1"
                                            )}
                                          />
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            <div className="mt-4 flex items-center justify-end">
                              <button
                                type="button"
                                onClick={openMcpModal}
                                disabled={!canManageSkills}
                                className={cn(
                                  "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                                  isDark ? "bg-white/10 text-white hover:bg-white/20" : "bg-black text-white hover:bg-black/90"
                                )}
                              >
                                Add server
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : activeTab === "integrations" ? (
                    <div className="space-y-4">
                      {integrationError ? (
                        <div
                          className={cn(
                            "rounded-xl border px-3 py-2 text-xs",
                            isDark ? "border-red-400/30 bg-red-500/10 text-red-200" : "border-red-300 bg-red-50 text-red-700"
                          )}
                        >
                          {integrationError}
                        </div>
                      ) : null}
                      {integrationNotice ? (
                        <div
                          className={cn(
                            "rounded-xl border px-3 py-2 text-xs",
                            isDark
                              ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                              : "border-emerald-300 bg-emerald-50 text-emerald-700"
                          )}
                        >
                          {integrationNotice}
                        </div>
                      ) : null}
                      <div className="grid gap-3">
                        {integrationOrder.map((provider) => {
                          const meta = integrationCatalog[provider];
                          const state = integrationState[provider];
                          const Logo = meta.logo;
                          const expanded = integrationModalOpen && integrationFocusProvider === provider;

                          return (
                            <div
                              key={provider}
                              className={cn(
                                "rounded-2xl border px-4 py-4 transition-colors",
                                expanded
                                  ? isDark
                                    ? "border-white/25 bg-white/10"
                                    : "border-black/20 bg-black/[0.02]"
                                  : isDark
                                    ? "border-white/10 bg-white/5"
                                    : "border-black/10 bg-white"
                              )}
                            >
                              <div className="flex flex-col gap-3">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                  <div className="flex items-center gap-3">
                                    <div
                                      className={cn(
                                        "h-10 w-10 rounded-2xl border flex items-center justify-center",
                                        isDark
                                          ? "border-white/10 bg-white/5 text-white"
                                          : "border-black/10 bg-white text-black"
                                      )}
                                    >
                                      <Logo className="h-5 w-5" />
                                    </div>
                                    <div>
                                      <div className="text-sm font-semibold">{meta.title}</div>
                                      <div className={cn("mt-0.5 text-xs", isDark ? "text-white/55" : "text-black/50")}>
                                        {meta.description}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span
                                      className={cn(
                                        "rounded-full px-2.5 py-1 text-[11px] font-medium",
                                        state.hasToken
                                          ? isDark
                                            ? "bg-emerald-500/20 text-emerald-200"
                                            : "bg-emerald-100 text-emerald-700"
                                          : isDark
                                            ? "bg-white/10 text-white/70"
                                            : "bg-black/5 text-black/60"
                                      )}
                                    >
                                      {state.hasToken ? "Connected" : "Not connected"}
                                    </span>
                                    <a
                                      href={meta.authUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={() => setIntegrationFocusProvider(provider)}
                                      className={cn(
                                        "inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                                        isDark
                                          ? "border-white/10 text-white/80 hover:border-white/30 hover:text-white"
                                          : "border-black/10 text-black/70 hover:border-black/30 hover:text-black"
                                      )}
                                    >
                                      {meta.authLabel}
                                    </a>
                                    <button
                                      type="button"
                                      onClick={() => openIntegrationModal(provider)}
                                      className={cn(
                                        "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                                        isDark
                                          ? "bg-white/10 text-white hover:bg-white/20"
                                          : "bg-black/5 text-black hover:bg-black/10"
                                      )}
                                    >
                                      {state.hasToken ? "Manage" : "Add token"}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {integrationModalOpen && modalProvider && modalMeta && modalState ? (
                        <div
                          className="fixed inset-0 z-[120] flex items-start sm:items-center justify-center bg-black/60 px-4 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-[calc(env(safe-area-inset-bottom)+1.25rem)] overflow-y-auto sm:pt-0 sm:pb-0"
                          onClick={closeIntegrationModal}
                        >
                          <div
                            className={cn(
                              "w-full max-w-[620px] max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-2xl border px-5 py-5 shadow-2xl",
                              isDark ? "border-white/10 bg-[#0f1115] text-white" : "border-black/10 bg-white text-black"
                            )}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-3">
                                <div
                                  className={cn(
                                    "h-10 w-10 rounded-2xl border flex items-center justify-center",
                                    isDark ? "border-white/10 bg-white/5 text-white" : "border-black/10 bg-white text-black"
                                  )}
                                >
                                  {ModalLogo ? <ModalLogo className="h-5 w-5" /> : null}
                                </div>
                                <div>
                                  <div className="text-sm font-semibold">{modalMeta.title}</div>
                                  <div className={cn("mt-0.5 text-xs", isDark ? "text-white/55" : "text-black/50")}>
                                    {modalMeta.description}
                                  </div>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={closeIntegrationModal}
                                className={cn(
                                  "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                                  isDark
                                    ? "bg-white/10 text-white hover:bg-white/20"
                                    : "bg-black/5 text-black hover:bg-black/10"
                                )}
                              >
                                Close
                              </button>
                            </div>
                            {integrationError ? (
                              <div
                                className={cn(
                                  "mt-4 rounded-xl border px-3 py-2 text-xs",
                                  isDark ? "border-red-400/30 bg-red-500/10 text-red-200" : "border-red-300 bg-red-50 text-red-700"
                                )}
                              >
                                {integrationError}
                              </div>
                            ) : null}
                            {integrationNotice ? (
                              <div
                                className={cn(
                                  "mt-3 rounded-xl border px-3 py-2 text-xs",
                                  isDark
                                    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                                    : "border-emerald-300 bg-emerald-50 text-emerald-700"
                                )}
                              >
                                {integrationNotice}
                              </div>
                            ) : null}
                            <div
                              className={cn(
                                "mt-4 rounded-xl border px-3 py-3",
                                isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-black/[0.02]"
                              )}
                            >
                              <label className={cn("text-xs", isDark ? "text-white/60" : "text-black/50")}>
                                {modalMeta.tokenLabel}
                              </label>
                              <input
                                type="password"
                                autoComplete="off"
                                autoFocus={open && activeTab === "integrations"}
                                value={modalState.token}
                                onChange={(event) => {
                                  modalState.setToken(event.target.value);
                                  setIntegrationFocusProvider(modalProvider);
                                }}
                                onFocus={() => setIntegrationFocusProvider(modalProvider)}
                                placeholder={modalTokenPlaceholder}
                                className={cn(
                                  "mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                  isDark
                                    ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                    : "border-black/10 bg-white text-black focus:border-black/30"
                                )}
                              />
                              <div className="mt-3 flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => deleteIntegration(modalProvider)}
                                  disabled={!modalCanRemove}
                                  className={cn(
                                    "rounded-full px-3 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                                    isDark
                                      ? "bg-white/10 text-white hover:bg-white/20"
                                      : "bg-black/5 text-black hover:bg-black/10"
                                  )}
                                >
                                  {modalState.removing ? "Removing…" : "Disconnect"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => saveIntegrationToken(modalProvider)}
                                  disabled={!modalCanSave}
                                  className={cn(
                                    "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                                    isDark
                                      ? "bg-white/10 text-white hover:bg-white/20"
                                      : "bg-black text-white hover:bg-black/90"
                                  )}
                                >
                                  {modalState.saving
                                    ? "Saving…"
                                    : modalState.hasToken
                                      ? "Update token"
                                      : "Save token"}
                                </button>
                              </div>
                            </div>
                            {modalProvider === "github" ? (
                              <div
                                className={cn(
                                  "mt-4 rounded-xl border px-3 py-3",
                                  isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-black/[0.02]"
                                )}
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Repositories</div>
                                  <button
                                    type="button"
                                    onClick={() => setShowGithubRepoForm((prev) => !prev)}
                                    disabled={!canManageIntegrations || !hasGithubToken}
                                    className={cn(
                                      "rounded-full px-3 py-1.5 text-[11px] font-semibold transition-opacity disabled:opacity-50",
                                      isDark
                                        ? "bg-white/10 text-white hover:bg-white/20"
                                        : "bg-black/5 text-black hover:bg-black/10"
                                    )}
                                  >
                                    {showGithubRepoForm ? "Close" : "Add repo"}
                                  </button>
                                </div>
                                {!hasGithubToken ? (
                                  <div className={cn("mt-2 text-xs", isDark ? "text-white/60" : "text-black/60")}>
                                    Connect a GitHub token to add private repositories.
                                  </div>
                                ) : githubReposLoading ? (
                                  <div className={cn("mt-2 text-xs", isDark ? "text-white/60" : "text-black/60")}>
                                    Loading repositories...
                                  </div>
                                ) : githubRepoConnections.length === 0 ? (
                                  <div className={cn("mt-2 text-xs", isDark ? "text-white/60" : "text-black/60")}>
                                    No connected repos yet.
                                  </div>
                                ) : (
                                  <div className="mt-2 space-y-2">
                                    {githubRepoConnections.map((connection) => (
                                      <div
                                        key={connection.id}
                                        className={cn(
                                          "rounded-lg border px-2.5 py-2 text-xs flex items-center justify-between gap-2",
                                          isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-white"
                                        )}
                                      >
                                        <div className="min-w-0">
                                          <div className="truncate font-medium">{connection.repoFullName}</div>
                                          <div className={cn("mt-0.5", isDark ? "text-white/60" : "text-black/60")}>
                                            {connection.isPrivate ? "Private" : "Public"} - base {connection.baseBranch} / work{" "}
                                            {connection.workBranch} -{" "}
                                            {connection.defaultPublishMode === "pr" ? "PR default" : "Direct push"}
                                          </div>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => removeGithubRepoConnection(connection.id)}
                                          disabled={removingGithubRepoId === connection.id}
                                          className={cn(
                                            "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-opacity disabled:opacity-60",
                                            isDark
                                              ? "bg-white/10 text-white hover:bg-white/20"
                                              : "bg-black/5 text-black hover:bg-black/10"
                                          )}
                                        >
                                          {removingGithubRepoId === connection.id ? "Removing..." : "Disconnect"}
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {showGithubRepoForm && hasGithubToken ? (
                                  <div className="mt-3 grid gap-2">
                                    <input
                                      type="text"
                                      value={githubRepoFullName}
                                      onChange={(event) => setGithubRepoFullName(event.target.value)}
                                      placeholder="owner/repo"
                                      className={cn(
                                        "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                        isDark
                                          ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                          : "border-black/10 bg-white text-black focus:border-black/30"
                                      )}
                                    />
                                    <div className="grid grid-cols-2 gap-2">
                                      <input
                                        type="text"
                                        value={githubRepoBaseBranch}
                                        onChange={(event) => setGithubRepoBaseBranch(event.target.value)}
                                        placeholder="Base branch (main)"
                                        className={cn(
                                          "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                          isDark
                                            ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                            : "border-black/10 bg-white text-black focus:border-black/30"
                                        )}
                                      />
                                      <input
                                        type="text"
                                        value={githubRepoWorkBranch}
                                        onChange={(event) => setGithubRepoWorkBranch(event.target.value)}
                                        placeholder="Work branch (tuna)"
                                        className={cn(
                                          "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                                          isDark
                                            ? "border-white/10 bg-white/5 text-white focus:border-white/30"
                                            : "border-black/10 bg-white text-black focus:border-black/30"
                                        )}
                                      />
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                      <label className="inline-flex items-center gap-2 text-xs">
                                        <input
                                          type="checkbox"
                                          checked={githubRepoPrivate}
                                          onChange={(event) => setGithubRepoPrivate(event.target.checked)}
                                        />
                                        Private repo
                                      </label>
                                      <select
                                        value={githubRepoPublishMode}
                                        onChange={(event) =>
                                          setGithubRepoPublishMode(event.target.value === "direct" ? "direct" : "pr")
                                        }
                                        className={cn(
                                          "rounded-lg border px-2 py-1.5 text-xs outline-none",
                                          isDark ? "border-white/10 bg-white/5 text-white" : "border-black/10 bg-white text-black"
                                        )}
                                      >
                                        <option value="pr">Default: PR</option>
                                        <option value="direct">Default: direct push</option>
                                      </select>
                                    </div>
                                    <div className="flex items-center justify-end gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setShowGithubRepoForm(false)}
                                        className={cn(
                                          "rounded-full px-3 py-2 text-xs font-semibold transition-opacity",
                                          isDark
                                            ? "bg-white/10 text-white hover:bg-white/20"
                                            : "bg-black/5 text-black hover:bg-black/10"
                                        )}
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="button"
                                        onClick={saveGithubRepoConnection}
                                        disabled={!canManageIntegrations || savingGithubRepo || !hasGithubToken}
                                        className={cn(
                                          "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                                          isDark
                                            ? "bg-white/10 text-white hover:bg-white/20"
                                            : "bg-black text-white hover:bg-black/90"
                                        )}
                                      >
                                        {savingGithubRepo ? "Saving repo..." : "Connect repo"}
                                      </button>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : activeTab === "controls" ? (
                    <div className="space-y-5">
                      <div>
                        <div className="text-sm font-medium">How should the agent operate by default?</div>
                        <div className="mt-3 grid gap-3">
                          {modeOptions.map((option) => {
                            const selected = defaultMode === option.id;
                            const Icon = option.icon;
                            return (
                            <button
                                key={option.id}
                                type="button"
                                onClick={() => setDefaultMode(option.id)}
                                className={cn(
                                "rounded-xl border px-4 py-3 text-left transition-colors overflow-hidden min-h-[96px] max-h-[96px]",
                                  selected
                                    ? isDark
                                      ? "border-white/40 bg-white/10 text-white"
                                      : "border-black/30 bg-black/5 text-black"
                                    : isDark
                                      ? "border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
                                      : "border-black/10 bg-white text-black/70 hover:bg-black/5"
                                )}
                              >
                                <div className="flex items-start gap-3">
                                  <div
                                    className={cn(
                                      "mt-0.5 rounded-md p-1.5",
                                      selected
                                        ? isDark
                                          ? "bg-white/15"
                                          : "bg-black/5"
                                        : isDark
                                          ? "bg-white/10"
                                          : "bg-black/5"
                                    )}
                                  >
                                    <Icon className="h-4 w-4" />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium line-clamp-1">{option.title}</div>
                                    <div className={cn("mt-1 text-xs line-clamp-2", isDark ? "text-white/50" : "text-black/50")}>
                                      {option.description}
                                    </div>
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        <div className={cn("mt-2 text-xs", isDark ? "text-white/50" : "text-black/50")}>
                          This just sets your default. You can switch modes any time.
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={saveControls}
                          disabled={!userId || savingControls}
                          className={cn(
                            "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                            isDark
                              ? "bg-white/10 text-white hover:bg-white/20"
                              : "bg-black text-white hover:bg-black/90"
                          )}
                        >
                          {savingControls ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className={cn(
                        "rounded-2xl border px-4 py-6 text-sm",
                        isDark ? "border-white/10 bg-white/5 text-white/70" : "border-black/10 bg-white text-black/60"
                      )}
                    >
                      This section is coming soon.
                    </div>
                  )}
                </div>
              </section>
            </div>
            {mcpModalOpen ? (
              <div
                className="fixed inset-0 z-[120] flex items-start sm:items-center justify-center bg-black/60 px-4 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-[calc(env(safe-area-inset-bottom)+1.25rem)] overflow-y-auto sm:pt-0 sm:pb-0"
                onClick={closeMcpModal}
              >
                <div
                  className={cn(
                    "w-full max-w-[620px] max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-2xl border px-5 py-5 shadow-2xl",
                    isDark ? "border-white/10 bg-[#0f1115] text-white" : "border-black/10 bg-white text-black"
                  )}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "h-10 w-10 rounded-2xl border flex items-center justify-center",
                          isDark ? "border-white/10 bg-white/5 text-white" : "border-black/10 bg-white text-black"
                        )}
                      >
                        <McpLogo className="h-5 w-5" isDark={isDark} />
                      </div>
                      <div>
                        <div className="text-sm font-semibold">Add MCP server</div>
                        <div className={cn("mt-0.5 text-xs", isDark ? "text-white/55" : "text-black/50")}>
                          Configure a server-side connector.
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={closeMcpModal}
                      className={cn(
                        "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                        isDark ? "bg-white/10 text-white hover:bg-white/20" : "bg-black/5 text-black hover:bg-black/10"
                      )}
                    >
                      Close
                    </button>
                  </div>
                  {mcpFormError ? (
                    <div
                      className={cn(
                        "mt-4 rounded-xl border px-3 py-2 text-xs",
                        isDark ? "border-red-400/30 bg-red-500/10 text-red-200" : "border-red-300 bg-red-50 text-red-700"
                      )}
                    >
                      {mcpFormError}
                    </div>
                  ) : null}
                  <div
                    className={cn(
                      "mt-4 rounded-xl border px-3 py-3 text-sm",
                      isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-black/[0.02]"
                    )}
                  >
                    <div className="mt-1 grid gap-2">
                      <input
                        value={mcpFormLabel}
                        onChange={(event) => setMcpFormLabel(event.target.value)}
                        placeholder="Label (e.g., My MCP)"
                        className={cn(
                          "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                          isDark ? "border-white/10 bg-white/5 text-white focus:border-white/30" : "border-black/10 bg-white text-black focus:border-black/30"
                        )}
                        disabled={!canManageSkills || mcpSubmitting}
                      />
                      <input
                        value={mcpFormUrl}
                        onChange={(event) => setMcpFormUrl(event.target.value)}
                        placeholder="https://your-mcp-server.example.com/mcp"
                        className={cn(
                          "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                          isDark ? "border-white/10 bg-white/5 text-white focus:border-white/30" : "border-black/10 bg-white text-black focus:border-black/30"
                        )}
                        disabled={!canManageSkills || mcpSubmitting}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          value={mcpFormHeaderName}
                          onChange={(event) => setMcpFormHeaderName(event.target.value)}
                          placeholder="Header name (optional)"
                          className={cn(
                            "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                            isDark ? "border-white/10 bg-white/5 text-white focus:border-white/30" : "border-black/10 bg-white text-black focus:border-black/30"
                          )}
                          disabled={!canManageSkills || mcpSubmitting}
                        />
                        <input
                          value={mcpFormHeaderValue}
                          onChange={(event) => setMcpFormHeaderValue(event.target.value)}
                          placeholder="Header value"
                          className={cn(
                            "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors",
                            isDark ? "border-white/10 bg-white/5 text-white focus:border-white/30" : "border-black/10 bg-white text-black focus:border-black/30"
                          )}
                          disabled={!canManageSkills || mcpSubmitting}
                        />
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={closeMcpModal}
                        disabled={mcpSubmitting}
                        className={cn(
                          "rounded-full px-3 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                          isDark ? "bg-white/10 text-white hover:bg-white/20" : "bg-black/5 text-black hover:bg-black/10"
                        )}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={submitMcpServer}
                        disabled={!canManageSkills || mcpSubmitting}
                        className={cn(
                          "rounded-full px-4 py-2 text-xs font-semibold transition-opacity disabled:opacity-60",
                          isDark ? "bg-white/10 text-white hover:bg-white/20" : "bg-black text-white hover:bg-black/90"
                        )}
                      >
                        {mcpSubmitting ? "Adding…" : "Add server"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
