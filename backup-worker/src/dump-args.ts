/** Helpers for constructing safe, testable mongodump argument lists. */
export function hasDatabasePath(uri: string): boolean {
  const schemeEnd = uri.indexOf('://')
  if (schemeEnd < 0) return false
  const authority = uri.slice(schemeEnd + 3)
  const slash = authority.indexOf('/')
  if (slash < 0) return false
  const pathAndQuery = authority.slice(slash + 1)
  const database = pathAndQuery.split(/[?#]/, 1)[0] ?? ''
  return database.length > 0
}

export function hasReplicaSetMarker(uri: string): boolean {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol.toLowerCase() === 'mongodb+srv:') return true
    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase() === 'replicaset' && parsed.searchParams.get(key)?.trim()) return true
    }
    return false
  } catch {
    return false
  }
}

export function buildMongodumpArgs(
  configPath: string,
  dumpDirectory: string,
  mongoUri: string,
  useOplog: boolean,
): string[] {
  if (useOplog && hasDatabasePath(mongoUri)) {
    throw new Error('BACKUP_OPLOG_REQUIRES_MONGO_URI_WITHOUT_DATABASE_PATH')
  }
  if (useOplog && !hasReplicaSetMarker(mongoUri)) {
    throw new Error('BACKUP_OPLOG_REQUIRES_REPLICA_SET_URI')
  }
  const args = [`--config=${configPath}`, `--out=${dumpDirectory}`, '--gzip']
  if (useOplog) args.push('--oplog')
  return args
}
