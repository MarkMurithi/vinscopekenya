import test from 'node:test';
import assert from 'node:assert/strict';
import { initiateStkPush } from '../mpesa.js';

test('initiateStkPush returns a demo checkout payload when M-Pesa is not configured', async () => {
  delete process.env.MPESA_CONSUMER_KEY;
  delete process.env.MPESA_CONSUMER_SECRET;
  delete process.env.MPESA_SHORTCODE;
  delete process.env.MPESA_PASSKEY;

  const result = await initiateStkPush({
    phone: '0712345678',
    amount: 999,
    plan: 'Pro',
    callbackUrl: 'https://example.com/api/payments/mpesa/callback',
  });

  assert.equal(result.ResponseCode, '0');
  assert.match(result.CheckoutRequestID, /^demo-/);
  assert.match(result.CustomerMessage, /Demo M-Pesa/i);
});
