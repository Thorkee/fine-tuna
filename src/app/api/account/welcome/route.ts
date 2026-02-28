import { createClient } from "@/lib/supabase/server";
import { sendWelcomeEmail } from "@/lib/notifications/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("full_name, preferences")
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr) {
    return Response.json({ error: "Failed to load profile" }, { status: 500 });
  }

  const prefs = (profile?.preferences ?? {}) as Record<string, unknown>;
  const commPrefs = isRecord(prefs.comm) ? prefs.comm : {};
  const existingSentAt =
    typeof commPrefs.welcome_sent_at === "string" ? commPrefs.welcome_sent_at.trim() : "";

  if (existingSentAt) {
    return Response.json({ ok: true, sent: false });
  }

  try {
    await sendWelcomeEmail({
      email: user.email,
      name: profile?.full_name ?? (user.user_metadata?.full_name as string | undefined),
    });
  } catch (error) {
    console.error("Failed to send welcome email:", error);
    return Response.json({ error: "Failed to send welcome email" }, { status: 500 });
  }

  const nextPrefs = {
    ...prefs,
    comm: {
      ...commPrefs,
      welcome_sent_at: new Date().toISOString(),
    },
  };

  const { error: updateErr } = await supabase
    .from("profiles")
    .upsert({ id: user.id, preferences: nextPrefs }, { onConflict: "id" });

  if (updateErr) {
    return Response.json({ error: updateErr.message }, { status: 500 });
  }

  return Response.json({ ok: true, sent: true });
}
