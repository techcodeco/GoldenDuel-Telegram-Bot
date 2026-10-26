import { notify } from "../bot/notify";
import { formatAmount } from "../money";
import { t } from "../i18n";
import { User } from "../models";
import { getSettings } from "./settings";
import { getUser } from "./users";
import { applyOp, houseOp, runTx } from "./wallet";

/**
 * Pay the inviter once, after the invited user completes their first duel.
 * Currency follows the inviter's selected language and the lifetime bonus cap is enforced atomically.
 */
export async function payReferral(userId: number): Promise<void> {
  const cfg = await getSettings();
  const result: any = await runTx(async (s) => {
    const invited = await User.findOne({ tgId: userId }).session(s).lean();
    if (!invited?.referrerId || invited.referralPaid) return null;

    const claimed = await User.updateOne(
      { tgId: userId, referralPaid: false },
      { $set: { referralPaid: true } },
      { session: s },
    );
    if (claimed.modifiedCount !== 1) return null;

    const inviter = await User.findOne({ tgId: invited.referrerId })
      .session(s)
      .lean();
    if (!inviter) return null;
    const currency = inviter.lang === "fa" ? "IRT" : "TON";
    const reward = Number(
      cfg.referral.reward?.[currency] ??
        (currency === "IRT" ? cfg.referral.rewardIRT : 0),
    );
    const cap = Math.max(0, Math.floor(cfg.referral.maxPaidReferrals ?? 100));
    if (reward <= 0 || cap <= 0) return null;

    // Conditional update works as the atomic cap reservation if multiple referrals finish concurrently.
    const reserved = await User.findOneAndUpdate(
      {
        tgId: inviter.tgId,
        $or: [
          { referralBonusCount: { $lt: cap } },
          { referralBonusCount: { $exists: false } },
        ],
      },
      { $inc: { referralBonusCount: 1 } },
      { session: s, new: true },
    ).lean();
    if (!reserved) return null;

    await applyOp(s, {
      key: `ref:${userId}`,
      userId: inviter.tgId,
      currency,
      type: "referral",
      available: reward,
      locked: 0,
      ref: String(userId),
    });
    await houseOp(
      s,
      `refx:${userId}`,
      currency,
      -reward,
      "referral_expense",
      String(userId),
    );
    return {
      inviterId: inviter.tgId,
      currency,
      reward,
      lang: inviter.lang === "fa" ? ("fa" as const) : ("en" as const),
    };
  });

  if (result) {
    const lang = (await getUser(result.inviterId))?.lang ?? result.lang;
    await notify(
      result.inviterId,
      t(lang, "referral.reward", {
        amount: formatAmount(result.reward, result.currency),
        cur: t(lang, result.currency === "IRT" ? "cur.IRT" : "cur.TON"),
      }),
    );
  }
}
