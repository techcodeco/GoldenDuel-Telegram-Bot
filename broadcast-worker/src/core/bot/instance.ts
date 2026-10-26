import { autoRetry } from '@grammyjs/auto-retry'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import { Bot } from 'grammy'
import { BOT_TOKEN } from '../config'

export const bot = new Bot(BOT_TOKEN)

// The worker sends Telegram API requests only; message handlers and context types stay in private-worker.
bot.api.config.use(apiThrottler())
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }))
