import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteStoragePrefix } from "@/lib/supabase/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const userId = user.id;

  try {
    const { data: chats, error: chatsErr } = await supabase
      .from("chats")
      .select("id")
      .eq("user_id", userId);
    if (chatsErr) {
      throw new Error(chatsErr.message);
    }

    const chatIds = (chats ?? [])
      .map((chat) => (chat?.id ?? "").toString())
      .filter((id) => id.length > 0);

    await deleteStoragePrefix("uploads", `${userId}/`);

    for (const chatId of chatIds) {
      await deleteStoragePrefix("artifacts", `exports/${chatId}/`);
    }

    const { error: deleteChatsErr } = await supabase
      .from("chats")
      .delete()
      .eq("user_id", userId);
    if (deleteChatsErr) {
      throw new Error(deleteChatsErr.message);
    }

    const admin = createAdminClient();
    const { error: deleteUserErr } = await admin.auth.admin.deleteUser(userId);
    if (deleteUserErr) {
      throw new Error(deleteUserErr.message);
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete account:", error);
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
