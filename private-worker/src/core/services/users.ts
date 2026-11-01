import { randomBytes } from "node:crypto";
import { OWNER_IDS } from "../config";
import type { Lang } from "../i18n";
import { type IUser, User, zeroBalances } from "../models";
import { redis } from "../redis";

/** What is cached in Redis (no balances: money is always read from Mongo). */
export interface CachedUser {
  tgId: number;
  lang: Lang | null;
  role: IUser["role"];
  registrationBonusPending: boolean;
  firstName?: string;
}

const key = (id: number) => `u:${id}`;
const effectiveRole = (id: number, role: IUser["role"]): IUser["role"] =>
  OWNER_IDS.has(id) ? "owner" : role;

export async function getUser(id: number): Promise<CachedUser | null> {
  const raw = await redis.get(key(id));
  if (raw) return raw === "null" ? null : (JSON.parse(raw) as CachedUser);
  const doc = await User.findOne({ tgId: id })
    .select("tgId lang role registrationBonusPending")
    .lean();
  if (!doc) {
    await redis.set(key(id), "null", "EX", 30); // short negative cache
    return null;
  }
  const cu: CachedUser = {
    tgId: doc.tgId,
    lang: (doc.lang as Lang | null) ?? null,
    role: effectiveRole(id, doc.role),
    registrationBonusPending: Boolean(doc.registrationBonusPending),
  };
  await redis.set(key(id), JSON.stringify(cu), "EX", 3600);
  return cu;
}

export const dropUserCache = (id: number) => redis.del(key(id));

export async function createUser(
  from: { id: number; first_name?: string; username?: string },
  refToken: string | null,
): Promise<boolean> {
  let referrerId: number | null = null;
  if (refToken && /^[A-Za-z0-9_-]{7,12}$/.test(refToken)) {
    const referrer = await User.findOne({ refCode: refToken })
      .select("tgId")
      .lean();
    if (referrer && referrer.tgId !== from.id) referrerId = referrer.tgId;
  }
  const res = await User.updateOne(
    { tgId: from.id },
    {
      $setOnInsert: {
        tgId: from.id,
        lang: null,
        role: "user",
        referrerId,
        referralPaid: false,
        referralBonusCount: 0,
        registrationBonusPaid: false,
        registrationBonusPending: true,
        duelsPlayed: 0,
        blockedBot: false,
        balances: zeroBalances(),
      },
      $set: { firstName: from.first_name ?? "", username: from.username ?? "" },
    },
    { upsert: true, setDefaultsOnInsert: false },
  );
  await dropUserCache(from.id);
  // Backfill referral codes for accounts created by older versions.
  await getReferralCode(from.id);
  return res.upsertedCount === 1;
}

export async function setLang(id: number, lang: Lang): Promise<void> {
  await User.updateOne({ tgId: id }, { $set: { lang } });
  await dropUserCache(id);
}

export async function setRole(
  id: number,
  role: IUser["role"],
): Promise<boolean> {
  const r = await User.updateOne({ tgId: id }, { $set: { role } });
  await dropUserCache(id);
  return r.matchedCount === 1;
}

export async function markBlocked(id: number, blocked: boolean): Promise<void> {
  await User.updateOne({ tgId: id }, { $set: { blockedBot: blocked } });
}

export const fullUser = (id: number) => User.findOne({ tgId: id }).lean();

export async function referralCount(id: number): Promise<number> {
  return User.countDocuments({ referrerId: id });
}

/** A public referral token is random and opaque; never expose a Telegram numeric ID in referral URLs. */
export async function getReferralCode(id: number): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = await User.findOne({ tgId: id }).select("refCode").lean();
    if (!existing) throw new Error("user_not_found_for_referral_code");
    if (existing.refCode) return existing.refCode;
    const code = randomBytes(6).toString("base64url");
    try {
      await User.updateOne(
        {
          tgId: id,
          $or: [
            { refCode: { $exists: false } },
            { refCode: null },
            { refCode: "" },
          ],
        },
        { $set: { refCode: code } },
      );
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
    }
  }
  const existing = await User.findOne({ tgId: id }).select("refCode").lean();
  if (existing?.refCode) return existing.refCode;
  throw new Error("could_not_allocate_referral_code");
}
