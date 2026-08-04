import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVerificationCode, maskContact } from '../src/utils/verificationUtils.js';

test('generateVerificationCode creates a six-digit code', () => {
  const code = generateVerificationCode();

  assert.equal(code.length, 6);
  assert.match(code, /^\d{6}$/);
});

test('maskContact hides most characters while preserving the destination type', () => {
  assert.equal(maskContact('demo@vinscope.com', 'email'), 'd***@vinscope.com');
  assert.equal(maskContact('0712345678', 'sms'), '0712*****');
});
