import { BOT_USERNAME, STREAM_GROUPS, STREAM_PRIVATE } from "./config";

const norm = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[ي]/g, "ی")
    .replace(/[ك]/g, "ک")
    .trim()
    .toLocaleLowerCase("en-US");
const GROUP_WORDS = new Set([
  "fight",
  "/fight",
  "duel",
  "/duel",
  "competition",
  "/competition",
  "دوئل",
  "فایت",
  "رقابت",
  "help",
  "/help",
  "guide",
  "/guide",
  "راهنما",
  "کمک",
  "dashboard",
  "/dashboard",
  "panel",
  "/panel",
  "management",
  "/management",
  "پنل",
  "پانل",
  "مدیریت",
  "داشبورد",
  "challenge",
  "/challenge",
  "چالنج",
  "چالش",
  "چلنج",
]);

/** Only exact whole-message keywords enter the group stream; ordinary group chat is dropped. */
export function isGroupTrigger(text: string | undefined): boolean {
  if (!text) return false;
  let s = norm(text);
  if (s.startsWith("/")) {
    if (!/^\/[a-z]+(?:@[a-z0-9_]+)?$/i.test(s)) return false;
    const at = s.indexOf("@");
    if (at >= 0) {
      const addressed = s.slice(at + 1);
      if (BOT_USERNAME && addressed !== BOT_USERNAME) return false;
      s = s.slice(0, at);
    }
  }

  return GROUP_WORDS.has(s);
}

// Returns target stream, or null to drop the update.
export function route(u: any): string | null {
  const cb = u.callback_query;
  if (cb) {
    // Group-game buttons can also be presented in the activator's private chat (wizard/dashboard).
    // Route only our namespaced callbacks to the group worker, regardless of callback message chat.
    if (String(cb.data ?? "").startsWith("gw:")) return STREAM_GROUPS;
    const t = cb.message?.chat?.type;
    return t === "group" || t === "supergroup"
      ? String(cb.data ?? "").startsWith("gw:")
        ? STREAM_GROUPS
        : null
      : STREAM_PRIVATE;
  }
  const m = u.message;
  if (m) {
    const t = m.chat?.type;
    if (t === "private") return STREAM_PRIVATE;
    if ((t === "group" || t === "supergroup") && isGroupTrigger(m.text))
      return STREAM_GROUPS;
    return null;
  }
  const mcm = u.my_chat_member;
  if (mcm) {
    const t = mcm.chat?.type;
    if (t === "private") return STREAM_PRIVATE;
    if (t === "group" || t === "supergroup") return STREAM_GROUPS;
    return null;
  }
  const chat = (u.message_reaction ?? u.edited_message)?.chat;
  return chat?.type === "private" ? STREAM_PRIVATE : null;
}
