// test/db.test.js — SQLite token store test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TokenStore = require('../src/db');

test('TokenStore operations', () => {
  const testDb = path.resolve(__dirname, 'test_tokens.sqlite');
  if (fs.existsSync(testDb)) fs.unlinkSync(testDb);

  const store = new TokenStore(testDb);
  assert.equal(store.count(), 0);

  const testTokens = [
    'U0dfV0VC#token_1_long_enough_to_be_valid_token',
    'U0dfV0VC#token_2_long_enough_to_be_valid_token',
  ];

  store.insertBatch(testTokens);
  assert.equal(store.count(), 2);

  const t1 = store.getNext();
  assert.equal(t1, testTokens[0]);

  store.remove(t1);
  assert.equal(store.count(), 1);

  const t2 = store.getNext();
  assert.equal(t2, testTokens[1]);

  store.remove(t2);
  assert.equal(store.count(), 0);
  assert.equal(store.getNext(), null);

  store.close();
  if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  const shm = testDb + '-shm';
  const wal = testDb + '-wal';
  if (fs.existsSync(shm)) fs.unlinkSync(shm);
  if (fs.existsSync(wal)) fs.unlinkSync(wal);
});
