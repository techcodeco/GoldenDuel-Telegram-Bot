export const en = {
  'lang.pick': '🌍 <b>Welcome!</b>\nChoose the language you would like to use with the bot:',
  'lang.fa': '🇮🇷 فارسی',
  'lang.en': '🇬🇧 English',
  welcome:
    '👋 Welcome <b>{name}</b>!\n\nChallenge other players to Rock · Paper · Scissors duels and win real rewards.\nUse the menu below to get started.',
  'menu.hint': 'Choose an option from the menu 👇',
  'finance.menu': '🏦 <b>Finance</b>\nManage your balance, deposits and withdrawals.',

  'btn.duel': '🟦 ⚔️ Duel',
  'btn.balance': '💰 Assets',
  'btn.friendly': '🤝 Friendly duel',
  'btn.finance_history': '📜 Financial history',
  'btn.duel_history': '📜 Duel history',
  'btn.support': '🆘 Support',
  'btn.deposit': '🟩 ➕ Top up',
  'btn.finance': '🏦 Finance',
  'btn.language': '🌐 Language',
  'btn.profile': '👤 Profile',
  'btn.admin': '🟩 🛠 Admin',
  'btn.withdraw': '🟥 💸 Withdraw',
  'btn.referral': '👥 Referral',
  'btn.back': '⬅️ Back',
  'btn.rock': '✊ Rock',
  'btn.paper': '✋ Paper',
  'btn.scissors': '✌️ Scissors',
  'btn.pay': '💳 Pay now',
  'btn.cancel_search': '❌ Cancel search',

  'cur.IRT': 'Toman',
  'cur.TON': 'TON (Gram)',
  'move.r': '✊ Rock',
  'move.p': '✋ Paper',
  'move.s': '✌️ Scissors',
  'move.none': '—',

  'balance.title': '💰 <b>Your balance</b>',
  'balance.line': '• {cur}: <b>{available}</b> available · {locked} reserved',

  'duel.choose_mode': '⚔️ Choose the duel type:',
  'duel.disabled': '⛔ New duels are temporarily disabled by the administrator.',
  'deposit.disabled': '⛔ Deposits are temporarily disabled by the administrator.',
  'withdraw.disabled': '⛔ Withdrawals are temporarily disabled by the administrator.',
  'chat.disabled': '⛔ Chat between opponents is temporarily disabled.',
  'duel.mode_bet': '💰 Bet duel',
  'duel.mode_friendly': '🤝 Friendly duel',
  'duel.choose_currency': '⚔️ Choose the currency of your duel:',
  'duel.choose_amount': '💵 Choose your bet ({cur}):',
  'duel.insufficient': '❌ Not enough balance. Deposit first, then try again.',
  'duel.busy': '⏳ You are already searching for an opponent or playing a duel.',
  'duel.invalid': '⚠️ This bet is not available any more. Please choose again.',
  'duel.searching': '🔎 Searching for an opponent with the same bet (<b>{amount} {cur}</b>)…\nYour stake is reserved and will be returned if nobody is found within <b>{duration}</b>.',
    'duel.cancelled': '✅ Search cancelled. Your stake was returned.',
  'duel.cancel_late': 'An opponent was just found — the duel can no longer be cancelled.',
  'duel.no_opponent': '😕 No opponent was found within <b>{duration}</b>. Your stake of {amount} {cur} was returned.',
  'duel.matched': '⚔️ <b>Opponent found!</b>\nBet: <b>{amount} {cur}</b>\nYou have <b>{duration}</b> to chat with your opponent and pick your move. Anything you type here is sent to them.\n\nPick your move:',
    'duel.chosen': `✅ <b>Your move is locked in!</b>
We are waiting for the opponent to choose. Good luck 🍀`,
  'duel.chosen_settled': `✅ <b>Your move was registered successfully!</b>
Both players have locked in their moves; the result is shown in a separate message. 🎯`,
  'duel.opponent_chosen': `⚡ Your opponent has already chosen!
Choose your move now. ⏳ {seconds} seconds left.`,
  'duel.reminder': `⏰ <b>Time is running out!</b>
Only <b>{seconds} seconds</b> remain. Tap Rock, Paper or Scissors now!`,
  'duel.matched_friendly': `🤝 <b>Friendly opponent found!</b>\nNo bet and no fees — just play for fun.\nYou have <b>{duration}</b> to chat and choose your move.\n\nMake your choice:`,
  'duel.searching_friendly': `🔎 Looking for a friendly opponent…\nNo money is reserved. If nobody joins within <b>{duration}</b>, the search ends.`,
    'duel.no_opponent_friendly': '😕 No friendly opponent joined within <b>{duration}</b>. Try again later.',
  'duel.already_chosen': 'You already picked your move.',
  'duel.finished': 'This duel is already finished.',
  'duel.time_over': 'Time is over for this duel.',
  'duel.not_yours': 'This duel is not yours.',

  'chat.from_opponent': '💬 Opponent: {text}',
  'chat.blocked': '🚫 Message not delivered: please keep the chat respectful.',
  'chat.profanity_penalty': '🚫 This message contains a filtered word and was not delivered. A penalty of <b>{amount} {cur}</b> has been deducted from your available balance.',
  'chat.profanity_penalty_no_balance': '🚫 This message contains a filtered word and was not delivered. The configured penalty is <b>{amount} {cur}</b>, but your available balance is insufficient, so no amount was deducted. Please avoid filtered words.',
  'chat.limit': '⚠️ You reached the message limit for this duel.',
  'chat.text_only': 'Only text messages are allowed in duel chat.',
  'chat.too_long': 'Message too long (max 300 characters).',

  'result.win':
    '🏆 <b>You won!</b>\nYou: {mine} · Opponent: {theirs}\nProfit: <b>+{profit} {cur}</b> (fee {fee} {cur})',
  'result.lose': '😔 <b>You lost.</b>\nYou: {mine} · Opponent: {theirs}\nLost: <b>-{stake} {cur}</b>',
  'result.win_timeout': '🏆 <b>You won!</b> You chose {mine}, but your opponent made no choice within the <b>{seconds}-second</b> time limit.\nProfit: <b>+{profit} {cur}</b> (fee {fee} {cur})',
  'result.lose_timeout': '⌛ <b>Time is over.</b> You made no choice within the <b>{seconds}-second</b> time limit, but your opponent chose {theirs} and won.\nLost: <b>-{stake} {cur}</b>',
    'result.draw':
    '🤝 <b>Draw!</b> You both picked {mine}.\nYour stake was returned minus a fee of {fee} {cur}.',
  'result.draw_timeout': '⌛ <b>Time expired and neither player made a choice.</b>\nNo moves were registered, so the result is a draw. Your stake was returned minus a fee of {fee} {cur}.',
    'result.balance': '💰 Balance: <b>{balance} {cur}</b>',
  'result.friendly_win': `🏆🎉 <b>Victory!</b> You won the friendly duel!
You: {mine} · Opponent: {theirs}
Great game — enjoy the win! ✨`,
  'result.friendly_lose': `💔 <b>Not this time!</b> You lost the friendly duel.
You: {mine} · Opponent: {theirs}
Rematch? You can do better! 💪`,
  'result.friendly_draw': `🤝 <b>It’s a draw!</b>
You both chose the same move: {mine}
A perfectly balanced duel. 🎯`,

  'result.friendly_win_timeout': '🏆 <b>You won!</b> You chose {mine}, but your opponent made no choice within {seconds} seconds.',
  'result.friendly_lose_timeout': '⌛ <b>Time expired.</b> You made no choice within the <b>{seconds}-second</b> time limit, but your opponent chose {theirs} and won.',
  'result.friendly_draw_timeout': '🤝 <b>Draw!</b> The {seconds}-second timer expired and neither player made a choice.',

  'deposit.choose': '➕ Choose the deposit currency:',
  'deposit.ask_IRT': 'Enter the deposit amount in <b>Toman</b> (minimum {min}):',
  'deposit.ask_TON': 'Enter the deposit amount in <b>TON (Gram)</b> (minimum {min}). Example: <code>0.5</code>:',
  'deposit.too_low': '❌ The minimum deposit is {min} {cur}.',
  'deposit.bad_amount': '❌ Invalid amount. Please send a number.',
  'deposit.manual_invoice': `━━━━━━━━━━━━━━━━━━━━
🧾 <b>ACCOUNT TOP-UP INVOICE</b>
━━━━━━━━━━━━━━━━━━━━

🔖 <b>Invoice number</b>  <code>{invoice}</code>
💰 <b>Amount due</b>
<code>{amount} {cur}</code>
🕒 Issued: {createdAt}
🟠 Status: <b>Pending review</b>

👤 <b>INVOICE OWNER</b>
Name: {name}
Username: {username}
Telegram ID: <code>{userId}</code>

🏦 <b>PAYMENT DESTINATION</b>
{paymentDetails}

⚠️ <b>IMPORTANT — BEFORE PAYING</b>
Transfer only the exact amount shown to the destination saved on this invoice. After payment, send your bank receipt or transaction slip to support in a private chat and include the <b>invoice number</b>. Your balance will not be credited until an administrator verifies the receipt.

🛟 <b>Support:</b> {supportLink}`,

  'deposit.manual_unconfigured': '⚠️ The administrator has not configured deposit details for this currency yet. Please try again later or contact support.',
  'deposit.manual_approved': '✅ Invoice <code>{invoice}</code> was approved and <b>{amount} {cur}</b> has been added to your balance.\n💰 Available balance: <b>{balance} {cur}</b>',
  'deposit.manual_rejected': '❌ Deposit invoice <code>{invoice}</code> was rejected.\nReason: <b>{reason}</b>\nContact support if you believe this was a mistake.',
  'deposit.unavailable': '⚠️ Deposit details are not fully configured or this method is temporarily unavailable. Please try again later.',
  'deposit.credited': '✅ Deposit of <b>{amount} {cur}</b> received.\n💰 Balance: <b>{balance} {cur}</b>',
  'deposit.ton_invoice': `🧾 <b>TON (Gram) deposit invoice</b>\n\nInvoice: <code>{invoice}</code>\nAmount: <b>{amount} TON (Gram)</b>\nReceiving wallet: <code>{address}</code>\nReference/comment: <code>{comment}</code>\nStatus: <b>Waiting for blockchain payment</b>\n\nTap <b>Pay with Tonkeeper</b> below. The wallet opens with the destination, exact amount and invoice reference prefilled. After sending, return here and tap <b>Check transaction</b>.\n\nThe blockchain transaction hash is created only after sending; when a matching finalized transaction is found, the bot records its hash and credits your balance automatically. Send the exact amount and keep the reference/comment unchanged.`,
  'deposit.ton_not_found': '❌ Invoice was not found or does not belong to your account.',
  'deposit.ton_pending': '⏳ No matching finalized TON transaction was found for this invoice yet. After sending, wait a little and check again. Make sure the exact amount and invoice comment were used.',
  'deposit.ton_paid': '✅ Invoice <code>{invoice}</code> confirmed on TON blockchain.\nCredited: <b>{amount} TON (Gram)</b>\nTransaction hash: <code>{txHash}</code>\nAvailable balance: <b>{balance} TON (Gram)</b>',
  'deposit.ton_already_used': '⚠️ This blockchain transaction appears to have already been used for another invoice. Contact support and provide the invoice number.',
  'deposit.ton_check_failed': '⚠️ The blockchain API could not be reached right now. Your invoice is still pending; try checking again shortly.',

  'withdraw.choose': '💸 Choose the withdrawal currency:',
  'withdraw.need_referrals': '❌ You need at least {need} referrals to withdraw. Current count: {have}.',
  'withdraw.need_duels': '❌ You need at least {need} completed bet duels to withdraw. Completed bet duels: {have}.',
  'withdraw.insufficient': '❌ Not enough balance. Minimum withdrawal is {min} {cur}; you have {available} {cur}.',
  'withdraw.ask_amount': 'Enter the total withdrawal request amount in {cur}.\nMinimum: {min} · Available: {available}',
  'withdraw.bad_amount': '❌ Invalid amount. Please send a number.',
  'withdraw.too_low': '❌ The minimum withdrawal is {min} {cur}.',
  'withdraw.too_high': '❌ You only have {available} {cur} available.',
  'withdraw.fee_too_high': '❌ This withdrawal amount cannot be submitted. Enter a different amount or contact support.',
  'withdraw.ask_dest_IRT': 'Send your <b>Iranian IBAN</b> (with IR or the 24 digits without IR).\nExample: <code>IRxxxxxxxxxxxxxxxxxxxxxxxx</code>\nBank card numbers are not accepted.',
  'withdraw.ask_account_name': '🏦 Destination bank: <b>{bank}</b>\n👤 Enter the IBAN account holder’s first and last name exactly as registered with the bank.\n⚠️ <b>The name must match the owner of this IBAN.</b> Otherwise, the withdrawal may be rejected.',
    'withdraw.iban_confirm': '🏦 <b>Confirm and create withdrawal invoice</b>\nRequested withdrawal amount: <b>{amount} {cur}</b>\nIBAN account holder: <b>{fullName}</b>\nDestination bank: <b>{bank}</b>\nIBAN: <code>{iban}</code>\n\n⚠️ Confirm the name matches the account holder and all details are correct. The final invoice breakdown will be shown after submission.',
  'withdraw.ask_dest_TON': 'Send your <b>TON (Gram)</b> receiving wallet address. Check it carefully; withdrawals are sent on the TON network:',
  'withdraw.ton_confirm': '💎 <b>Confirm and create TON (Gram) withdrawal invoice</b>\n\nRequested withdrawal amount: <b>{amount} {cur}</b>\nDestination wallet: <code>{address}</code>\n\n⚠️ Check every character of the address. TON transactions may be irreversible. The final invoice breakdown will be shown after submission. Is the destination correct?',
  'withdraw.bad_dest': '❌ Invalid destination. Please check and send it again.',
  'withdraw.bad_account_name': '❌ Invalid name. Enter the account holder’s first and last name (at least two parts).',
  'withdraw.confirm_use_buttons': 'Use the Confirm or Cancel buttons below the withdrawal confirmation to continue.',
  'withdraw.cancelled': '✅ Withdrawal was cancelled; no funds were reserved.',
  'withdraw.confirm_expired': '⌛ The withdrawal confirmation step expired. Please start the withdrawal again.',
  'withdraw.created': '✅ Withdrawal invoice <b>#{id}</b> has been created.\nTotal amount deducted from your available balance: <b>{amount} {cur}</b>\n{feeReason}: <b>{fee} {cur}</b>\n<b>Net amount you will receive after approval: {payout} {cur}</b>\nThe fee breakdown is shown now that the invoice has been created. The request has been sent to the owner for review.',
  'withdraw.paid': '✅ Your withdrawal <b>#{id}</b> has been paid.\nNet amount sent: <b>{payout} {cur}</b>\nFixed fee: <b>{fee} {cur}</b>.',
  'withdraw.rejected': '❌ Withdrawal invoice <b>#{id}</b> was rejected.\nThe full amount <b>{gross} {cur}</b> has been returned to your available balance; no fee was collected for a rejected request.\nRejection reason: <b>{reason}</b>',

  'referral.info':
    '👥 <b>Referral</b>\nInvite friends with your personal link:\n{link}\n\nInvited so far: <b>{count}</b>\nYou earn <b>{reward} {cur}</b> when an invited friend completes their first duel.',
  'referral.reward': '🎁 Your invited friend completed a duel! <b>+{amount} {cur}</b> added to your balance.',

  'profile.title': '👤 <b>Your profile</b>',
  'profile.identity': `Name: <b>{name}</b>
Username: {username}
Member since: {joined}`,
  'profile.duels': `⚔️ <b>Duel statistics</b>
Total completed: <b>{total}</b>
💰 Bet duels: {bet}
🤝 Friendly duels: {friendly}
🏆 Wins: {wins}
💔 Losses: {losses}
🤝 Draws: {draws}`,
  'profile.finance': `💳 <b>Financial statistics</b>
💵 Deposited: {depIRT} Toman · {depTON} TON (Gram)
🏆 Net winnings: {wonIRT} Toman · {wonTON} TON
📉 Losses: {lostIRT} Toman · {lostTON} TON
💸 Withdrawn: {wdIRT} Toman · {wdTON} TON
🎁 Referral rewards: {refIRT} Toman · {refTON} TON
🎉 Account bonus: {bonusIRT} Toman · {bonusTON} TON

💰 Available: {balIRT} Toman · {balTON} TON
🔒 Reserved: {lockIRT} Toman · {lockTON} TON
`, 
  'profile.btn_duels': '⚔️ Duel stats',
  'profile.btn_finance': '💳 Financial stats',
  'profile.btn_home': '⬅️ Back to profile',
  'profile.btn_language': '🌐 Change language',
  'admin.panel': `🛠 <b>Bot administration</b>
Use the buttons below to inspect statistics and manage all game parameters. Changes apply to new duels; already-running duels keep their saved settings.`,
  'admin.btn_stats': '📊 Statistics',
  'admin.btn_settings': '⚙️ Settings',
  'admin.btn_commands': '⌨️ Commands',
  'admin.btn_channels': '📢 Required channels',
  'admin.btn_home': '⬅️ Admin menu',
  'admin.btn_profile': '👤 User menu',
  'admin.btn_invoices': '🧾 Review deposit invoice',
  'admin.btn_withdrawals': '📤 Review withdrawal invoices',
  'admin.withdrawals_empty': '✅ There are no pending withdrawal invoices.',
  'admin.withdrawals_title': '📤 <b>Withdrawal invoices awaiting review</b>\nTap an invoice to inspect its details.',
  'admin.invoice_prompt': '🔎 Send the numeric tracking number for a deposit or withdrawal invoice. If the same code exists in multiple invoice types, all matching invoices will be shown.\nSend /cancel to exit.',
  'admin.invoice_not_found': '❌ No invoice was found with that numeric code. Check it and try again.',
  'admin.invoice_not_pending': 'ℹ️ This invoice has already been reviewed and cannot be approved or rejected again.',
  'admin.invoice_approved': '✅ The invoice was approved and the user balance was credited.',
  'admin.invoice_rejected': '✅ The invoice was rejected; the user balance was not changed.',
  'admin.deposit_rejection_reason_prompt': '✍️ Enter the reason for rejecting this deposit invoice in one message. It will be sent to the user. Send /cancel to abort.',
  'admin.withdraw_rejection_reason_prompt': '✍️ Enter the reason for rejecting this withdrawal invoice in one message. It will be sent to the user and the reserved amount will be refunded. Send /cancel to abort.',
  'admin.rejection_reason_invalid': '❌ The rejection reason must be between 3 and 500 characters. Try again or send /cancel.',
  'admin.invoice_invalid': '❌ The invoice code must be a positive whole number.',
  'admin.not_allowed': '⛔ This section is only available to bot admins.',
  'admin.setting_prompt': 'Send the new value for <b>{label}</b>. Current value: <code>{value}</code>. Send /cancel to exit.',
  'admin.setting_saved': '✅ <b>{label}</b> updated to <code>{value}</code>.',
  'admin.setting_invalid': '❌ Invalid value. Please send a valid number within the allowed range.',
  'admin.stats.title': '📊 <b>Bot statistics</b>',
  'admin.commands': `⌨️ <b>Management commands</b>
/admin — settings and help
/stats — users, active duels and financial totals
/bets IRT 10000,20000 — bet amounts
/fee win|draw|winTimeout|drawTimeout 10 — fees in percent
/limit minDeposit|minWithdraw IRT 20000 — payment limits
/set betMatchSeconds|friendlyMatchSeconds|betQueueSeconds|friendlyQueueSeconds|betChatLimit|friendlyChatLimit|minDuels number
/refreward 5000 — referral reward
/words add|del|list word — chat filter
/credit userId IRT 50000 — manual balance adjustment
/role userId admin|user — owner only`,

  'support.info': '🆘 <b>Support</b>\nFor help, contact the bot administrator.',
  'registration.bonus': '🎁 Your account creation bonus: <b>+{amount} {cur}</b> has been credited to your balance.',
  'membership.required': '🔐 <b>Required channel membership</b>\nPlease join every channel below, then tap “Check membership” to continue using the bot.',
  'membership.unavailable': '⚠️ Membership could not be verified. The administrator may need to add this bot as an administrator in the listed channels.',
  'membership.not_member': '❌ You are still not a member of all required channels. Join them and try again.',
  'membership.verified': '✅ Membership verified. You can use the bot now.',
  'error.generic': '⚠️ Something went wrong. Please try again.',
} as const

export type Key = keyof typeof en
