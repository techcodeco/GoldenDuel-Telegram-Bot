import assert from 'node:assert/strict'
import test from 'node:test'
import { groupInvitationDelivery, isOpenGroupFlow } from '../src/core/contracts/group'

test('a challenge created by replying to a specific user is not public', () => {
  assert.equal(isOpenGroupFlow({ openChallenge: false, targetId: 456 }), false)
  assert.equal(isOpenGroupFlow({ openChallenge: false, targetId: 0 }), false)
})

test('a challenge created without a reply target is public', () => {
  assert.equal(isOpenGroupFlow({ openChallenge: true, targetId: 0 }), true)
  assert.equal(isOpenGroupFlow({ targetId: 0 }), true)
})


test('reply-targeted invitations are announced publicly but accepted privately by the target', () => {
  assert.deepEqual(groupInvitationDelivery({ openChallenge: false, targetId: 456 }), {
    publicAnnouncement: true,
    publicAcceptButton: false,
    privateAcceptForm: true,
  })
})

test('challenges without a reply target are announced publicly with public acceptance', () => {
  assert.deepEqual(groupInvitationDelivery({ openChallenge: true, targetId: 0 }), {
    publicAnnouncement: true,
    publicAcceptButton: true,
    privateAcceptForm: false,
  })
})
