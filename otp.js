// SMS one-time-password (OTP) issuing and verification, used for SMS-based
// signup verification and passwordless phone login.
//
// Codes are hashed at rest (never stored in plaintext) and are single-use -
// verifyOtp() deletes the row as soon as it is successfully matched. Stored in
// Postgres (not an in-memory Map) because a single-process Map does not survive
// a redeploy or a Render free-tier instance restart between /send and /verify.
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
export async function issueOtp(pool, phone) {
  const normalized = normalizeKenyanPhone(phone);
  if (!normalized) return null;

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = $2, expires_at = $3, attempts = 0`,
    [normalized, hashCode(code), expiresAt]
  );

  return { normalized, code };
}

// Verifies a code against the stored row. Single-use: a match deletes the row.
export async function verifyOtp(pool, phone, code) {
  const normalized = normalizeKenyanPhone(phone);
  if (!normalized) return { success: false, message: 'Enter a valid Kenyan phone number.' };

  const { rows } = await pool.query(
    'SELECT code_hash, expires_at, attempts FROM otp_codes WHERE phone = $1',
    [normalized]
  );
  const entry = rows[0];
  if (!entry) return { success: false, message: 'Request a new verification code first.' };

  if (new Date(entry.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM otp_codes WHERE phone = $1', [normalized]);
    return { success: false, message: 'That code has expired. Request a new one.' };
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    await pool.query('DELETE FROM otp_codes WHERE phone = $1', [normalized]);
    return { success: false, message: 'Too many incorrect attempts. Request a new code.' };
  }

  if (hashCode(code) !== entry.code_hash) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1', [normalized]);
    return { success: false, message: 'That code does not match.' };
  }

  await pool.query('DELETE FROM otp_codes WHERE phone = $1', [normalized]);
  return { success: true, normalized };
}
