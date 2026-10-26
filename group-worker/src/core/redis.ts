import IORedis from 'ioredis'
import { REDIS_URL } from './config'
import { logError } from './logger'

export const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
export const redisBlock = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })

redis.on('error', (error) => logError('redis_connection_error', error, { connection: 'command' }))
redisBlock.on('error', (error) => logError('redis_connection_error', error, { connection: 'blocking' }))
