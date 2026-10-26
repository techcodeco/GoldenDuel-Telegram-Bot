import test from 'node:test'
import assert from 'node:assert/strict'
import { exactTrigger } from '../src/core/util'

test('accepts exact Persian and English game keywords', () => {
  for (const word of ['fight', 'duel', 'competition', 'دوئل', 'فایت', 'رقابت']) {
    assert.equal(exactTrigger(word), 'fight', word)
  }
})

test('accepts exact help and dashboard keywords', () => {
  for (const word of ['help', 'guide', 'راهنما', 'کمک']) assert.equal(exactTrigger(word), 'help', word)
  for (const word of ['dashboard', 'panel', 'management', 'پنل', 'پانل', 'مدیریت', 'داشبورد']) {
    assert.equal(exactTrigger(word), 'dashboard', word)
  }
})

test('does not treat a keyword embedded in ordinary chat as a command', () => {
  for (const text of ['این دوئل خوب است', 'please fight me', 'راهنما لطفا', 'پنل مدیریت گروه', 'we had a competition']) {
    assert.equal(exactTrigger(text), null, text)
  }
})

test('rejects slash commands with arguments or trailing text', () => {
  assert.equal(exactTrigger('/fight'), 'fight')
  assert.equal(exactTrigger('/help'), 'help')
  assert.equal(exactTrigger('/fight extra'), null)
  assert.equal(exactTrigger('/panel now'), null)
})
