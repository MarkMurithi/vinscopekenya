import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOtp, issueOtp, verifyOtp } from '../otp.js';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { pool, initializeDatabase } = await import('../server.js');
await initializeDatabase();

test('generateOtp creates a six-digit numeric code', () => {
  const code = generateOtp();
  assert.match(code, /^\d{6}$/);
});

test('issueOtp returns null for an invalid phone number', async () => {
  assert.equal(await issueOtp(pool, '12345'), null);
});

test('issueOtp normalizes the phone and verifyOtp validates the code exactly once', async () => {
  const issued = await issueOtp(pool, '0712345679');
  assert.ok(issued);
  assert.equal(issued.normalized, '254712345679');

  const wrongCode = issued.code === '000001' ? '000002' : '000001';
  const badAttempt = await verifyOtp(pool, '0712345679', wrongCode);
  assert.equal(badAttempt.success, false);

  const result = await verifyOtp(pool, '0712345679', issued.code);
  assert.equal(result.success, true);
  assert.equal(result.normalized, '254712345679');

  // Codes are single-use - verifying the same code again must fail.
  const reused = await verifyOtp(pool, '0712345679', issued.code);
  assert.equal(reused.success, false);
});

test('verifyOtp rejects a code when none was issued', async () => {
  const result = await verifyOtp(pool, '0798765432', '123456');
  assert.equal(result.success, false);
});
