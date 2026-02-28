import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import SharedChatReplay from "./SharedChatReplay";

type SharePageProps = {
  params: Promise<{ shareId: string }> | { shareId: string };
};

export async function generateMetadata(props: SharePageProps): Promise<Metadata> {
  const params = await props.params;
  const shareId = typeof params?.shareId === "string" ? params.shareId : "";

  const fallback: Metadata = {
    title: "Shared Chat — Tuna",
    description: "View a shared AI conversation on Tuna",
    openGraph: {
      title: "Shared Chat — Tuna",
      description: "View a shared AI conversation on Tuna",
      type: "website",
      siteName: "Tuna",
    },
    twitter: {
      card: "summary",
      title: "Shared Chat — Tuna",
      description: "View a shared AI conversation on Tuna",
    },
  };

  if (!shareId.trim()) return fallback;

  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("chat_shares")
      .select("snapshot")
      .eq("share_id", shareId)
      .maybeSingle();

    if (!data?.snapshot) return fallback;

    const snapshot = data.snapshot as {
      chat?: { title?: string };
      messages?: Array<{ role?: string; content?: string }>;
      createdAt?: string;
    };

    const chatTitle =
      typeof snapshot.chat?.title === "string" && snapshot.chat.title.trim()
        ? snapshot.chat.title.trim()
        : "Shared Chat";

    const messageCount = Array.isArray(snapshot.messages) ? snapshot.messages.length : 0;
    const description =
      messageCount > 0
        ? `View this ${messageCount}-message AI conversation: "${chatTitle}" on Tuna`
        : `View a shared AI conversation on Tuna`;

    const ogTitle = `${chatTitle} — Tuna`;

    return {
      title: ogTitle,
      description,
      openGraph: {
        title: ogTitle,
        description,
        type: "website",
        siteName: "Tuna",
      },
      twitter: {
        card: "summary",
        title: ogTitle,
        description,
      },
    };
  } catch {
    return fallback;
  }
}

export default async function Page(props: SharePageProps) {
  const params = await props.params;
  const shareId = typeof params?.shareId === "string" ? params.shareId : "";
  return <SharedChatReplay shareId={shareId} />;
}
