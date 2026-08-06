// SMS one-time-password (OTP) issuing and verification, used for SMS-based
// signup verification and passwordless phone login.
//
// Codes are hashed at rest (never stored in plaintext) and are single-use -
// verifyOtp() deletes the entry as soon as it is successfully matched.
//
// SMS delivery uses Africa's Talking (https://africastalking.com) when the
// following environment variables are set:
//   AFRICASTALKING_API_KEY
//   AFRICASTALKING_USERNAME
// Without them, sendSms() logs the message to the server console instead of
// failing, mirroring the M-Pesa "demo mode" fallback in mpesa.js.

import crypto from 'crypto';
import { normalizeKenyanPhone } from './mpesa.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const otpStore = new Map(); // normalized phone -> { codeHash, expiresAt, attempts }

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

export function isSmsConfigured() {
  return Boolean(
    String(process.env.AFRICASTALKING_API_KEY || '').trim() &&
    String(process.env.AFRICASTALKING_USERNAME || '').trim()
  );
}

export async function sendSms(to, message) {
  if (!isSmsConfigured()) {
    console.log(`[sms:demo] To ${to}: ${message}`);
    return { demo: true };
  }

  const response = await fetch('https://api.africastalking.com/version1/messaging', {
    method: 'POST',
    headers: {
      apiKey: process.env.AFRICASTALKING_API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ username: process.env.AFRICASTALKING_USERNAME, to, message }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.SMSMessageData?.Message || `Failed to send SMS (${response.status})`);
  }

  // Africa's Talking returns HTTP 200 even when the message wasn't actually
  // delivered - the real outcome is per-recipient, so check that too.
  const recipient = data?.SMSMessageData?.Recipients?.[0];
  if (recipient && recipient.status !== 'Success') {
    throw new Error(recipient.status || 'SMS was not delivered.');
  }

  return data;
}

// Generates and stores a fresh code for the given phone number, replacing any previous one.
export function issueOtp(phone) {
  const normalized = normalizeKenyanPhone(phone);
  if (!normalized) return null;

  const code = generateOtp();
  otpStore.set(normalized, { codeHash: hashCode(code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  return { normalized, code };
}

// Verifies a code against the stored entry. Single-use: a match deletes the entry.
export function verifyOtp(phone, code) {
  const normalized = normalizeKenyanPhone(phone);
  if (!normalized) return { success: false, message: 'Enter a valid Kenyan phone number.' };

  const entry = otpStore.get(normalized);
  if (!entry) return { success: false, message: 'Request a new verification code first.' };

  if (Date.now() > entry.expiresAt) {
    otpStore.delete(normalized);
    return { success: false, message: 'That code has expired. Request a new one.' };
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(normalized);
    return { success: false, message: 'Too many incorrect attempts. Request a new code.' };
  }

  if (hashCode(code) !== entry.codeHash) {
    entry.attempts += 1;
    return { success: false, message: 'That code does not match.' };
  }

  otpStore.delete(normalized);
  return { success: true, normalized };
}
