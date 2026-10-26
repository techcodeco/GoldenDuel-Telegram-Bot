import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMongodumpArgs, hasDatabasePath, hasReplicaSetMarker } from '../src/dump-args'

test('detects a scoped MongoDB database URI', () => {
  assert.equal(hasDatabasePath('mongodb://user:pass@localhost:27017/rps?authSource=admin'), true)
  assert.equal(hasDatabasePath('mongodb://localhost:27017/?replicaSet=rs0'), false)
  assert.equal(hasDatabasePath('mongodb://localhost:27017?replicaSet=rs0'), false)
})

test('creates a gzip BSON directory dump with one BSON file per collection', () => {
  assert.deepEqual(buildMongodumpArgs('/tmp/mongo.yml', '/tmp/dump', 'mongodb://localhost:27017/rps', false), [
    '--config=/tmp/mongo.yml', '--out=/tmp/dump', '--gzip',
  ])
})

test('replica-set URI marker detection accepts replicaSet query and SRV URI', () => {
  assert.equal(hasReplicaSetMarker('mongodb://localhost:27017/?replicaSet=rs0'), true)
  assert.equal(hasReplicaSetMarker('mongodb+srv://cluster.example.net/'), true)
  assert.equal(hasReplicaSetMarker('mongodb://localhost:27017/'), false)
})

test('oplog mode requires an unscoped replica-set URI', () => {
  assert.throws(
    () => buildMongodumpArgs('/tmp/mongo.yml', '/tmp/dump', 'mongodb://localhost:27017/rps?replicaSet=rs0', true),
    /BACKUP_OPLOG_REQUIRES_MONGO_URI_WITHOUT_DATABASE_PATH/,
  )
  assert.throws(
    () => buildMongodumpArgs('/tmp/mongo.yml', '/tmp/dump', 'mongodb://localhost:27017/', true),
    /BACKUP_OPLOG_REQUIRES_REPLICA_SET_URI/,
  )
  assert.deepEqual(buildMongodumpArgs('/tmp/mongo.yml', '/tmp/dump', 'mongodb://localhost:27017/?replicaSet=rs0', true), [
    '--config=/tmp/mongo.yml', '--out=/tmp/dump', '--gzip', '--oplog',
  ])
})
