// test/captcha.test.js — Captcha signing, hashing, and encryption logic
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  urlEncode,
  generateAliyunSignature,
  generateArg,
  aliHash,
  encrypt,
} = require('../src/captcha');

test('urlEncode encodes characters properly', () => {
  assert.equal(urlEncode('/'), '%2F');
  assert.equal(urlEncode('a-b_c.d~e'), 'a-b_c.d~e');
  assert.equal(urlEncode('hello world'), 'hello%20world');
});

test('generateAliyunSignature outputs base64 HMAC-SHA1', () => {
  const params = {
    AccessKeyId: 'test_key',
    Action: 'InitCaptchaV3',
  };
  const sig = generateAliyunSignature(params, 'secret');
  assert.ok(typeof sig === 'string' && sig.length > 0);
  assert.doesNotThrow(() => Buffer.from(sig, 'base64'));
});

test('generateArg deterministic execution', () => {
  const certifyId = 'test-certify-12345';
  const arg1 = generateArg(certifyId);
  const arg2 = generateArg(certifyId);
  assert.equal(arg1, arg2);
  assert.ok(arg1.length > 0);
});

test('aliHash generates 32-character hex output', () => {
  const hash = aliHash('{"test":"payload"}', '0000');
  assert.equal(hash.length, 32);
  assert.match(hash, /^[0-9a-f]{32}$/);
});

test('encrypt returns base64 string', () => {
  const ciphertext = encrypt(Buffer.from('test_data', 'utf8'));
  assert.ok(typeof ciphertext === 'string' && ciphertext.length > 0);
  assert.doesNotThrow(() => Buffer.from(ciphertext, 'base64'));
});
