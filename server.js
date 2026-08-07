import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { isValidVinFormat, decodeVinWithNhtsa, mapNhtsaResultToVehicle } from './vinDecoder.js';
import {
  AUTH_COOKIE_POLICY,
  EMAIL_REGEX,
  hashPassword,
  verifyPassword,
  signAccessToken,
  setAuthCookies,
  clearAuthCookies,
  requireAuth,
  setSessionVersionResolver,
  createRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiryDate,
  REFRESH_COOKIE_NAME,
} from './auth.js';
import {
  getMpesaConfigStatus,
  normalizeKenyanPhone,
  initiateStkPush,
  parseStkCallback,
} from './mpesa.js';
import { issueOtp, verifyOtp, sendSms } from './otp.js';

const { Pool } = pkg;
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

// In production the frontend is served from this same Express app, so no CORS is
// needed by default. Set ALLOWED_ORIGIN if the frontend is ever hosted separately
// (e.g. during local dev, the Vite dev server on http://localhost:5173).
const allowedOrigin = process.env.ALLOWED_ORIGIN || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigin === false ? true : allowedOrigin, credentials: true }));
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});
app.use(express.json());
app.use(cookieParser());
app.use(express.static(distDir));

// General API rate limit, plus separate throttling for login and registration to reduce brute force / abuse.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests. Please try again later.' },
});
app.use('/api', apiLimiter);

const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15);
const LOGIN_IP_MAX_FAILURES = Math.max(1, Number(process.env.LOGIN_IP_MAX_FAILURES || 5));
const LOGIN_IP_WINDOW_MINUTES = Math.max(1, Number(process.env.LOGIN_IP_WINDOW_MINUTES || 15));
const LOGIN_IP_LOCKOUT_MINUTES = Math.max(1, Number(process.env.LOGIN_IP_LOCKOUT_MINUTES || 15));
const OTP_SEND_MAX_PER_PHONE = Math.max(1, Number(process.env.OTP_SEND_MAX_PER_PHONE || 5));
const OTP_SEND_MAX_PER_IP = Math.max(1, Number(process.env.OTP_SEND_MAX_PER_IP || 20));
const OTP_SEND_WINDOW_MINUTES = Math.max(1, Number(process.env.OTP_SEND_WINDOW_MINUTES || 15));
const OTP_SEND_LOCKOUT_MINUTES = Math.max(1, Number(process.env.OTP_SEND_LOCKOUT_MINUTES || 30));
const OTP_VERIFY_MAX_FAILURES_PER_PHONE = Math.max(1, Number(process.env.OTP_VERIFY_MAX_FAILURES_PER_PHONE || 5));
const OTP_VERIFY_MAX_FAILURES_PER_IP = Math.max(1, Number(process.env.OTP_VERIFY_MAX_FAILURES_PER_IP || 10));
const OTP_VERIFY_WINDOW_MINUTES = Math.max(1, Number(process.env.OTP_VERIFY_WINDOW_MINUTES || 15));
const OTP_VERIFY_LOCKOUT_MINUTES = Math.max(1, Number(process.env.OTP_VERIFY_LOCKOUT_MINUTES || 30));
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const AUTH_ALERT_WINDOW_MINUTES = Math.max(1, Number(process.env.AUTH_ALERT_WINDOW_MINUTES || 60));
const LOCKOUT_ALERT_THRESHOLD = Math.max(1, Number(process.env.LOCKOUT_ALERT_THRESHOLD || 3));
const REFRESH_REUSE_ALERT_THRESHOLD = Math.max(1, Number(process.env.REFRESH_REUSE_ALERT_THRESHOLD || 1));
const AUTH_ALERT_WEBHOOK_URL = String(process.env.AUTH_ALERT_WEBHOOK_URL || '').trim();
const AUTH_ALERT_SLACK_WEBHOOK_URL = String(process.env.AUTH_ALERT_SLACK_WEBHOOK_URL || '').trim();
const AUTH_ALERT_EMAIL_FROM = String(process.env.AUTH_ALERT_EMAIL_FROM || '').trim();
const AUTH_ALERT_EMAIL_TO = String(process.env.AUTH_ALERT_EMAIL_TO || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const REFRESH_SESSION_IDLE_MINUTES = Math.max(1, Number(process.env.REFRESH_SESSION_IDLE_MINUTES || 10080));
const AUTH_ALERT_DELIVERY_MAX_ATTEMPTS = Math.max(1, Number(process.env.AUTH_ALERT_DELIVERY_MAX_ATTEMPTS || 3));
const AUTH_ALERT_DELIVERY_BASE_DELAY_MS = Math.max(50, Number(process.env.AUTH_ALERT_DELIVERY_BASE_DELAY_MS || 250));
const LEGAL_POLICY_VERSION = String(process.env.LEGAL_POLICY_VERSION || '2026-08-06').trim();

const LOCAL_DB_DEFAULT_URL = 'postgres://postgres:postgres@localhost:5432/vinscope';
const LOCAL_DB_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal']);

const isTrue = (value) => String(value || '').trim().toLowerCase() === 'true';

const parseDbUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isLocalDatabaseUrl = (value) => {
  const parsed = parseDbUrl(value);
  return Boolean(parsed && LOCAL_DB_HOSTNAMES.has((parsed.hostname || '').toLowerCase()));
};

function resolveDatabaseConnectionString() {
  const env = process.env.NODE_ENV || 'development';
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  const localDatabaseUrl = String(process.env.LOCAL_DATABASE_URL || '').trim();
  const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || '').trim();

  if (env === 'production') {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required in production.');
    }
    return databaseUrl;
  }

  if (env === 'test') {
    const candidate = testDatabaseUrl || localDatabaseUrl || databaseUrl || LOCAL_DB_DEFAULT_URL;
    if (!isLocalDatabaseUrl(candidate) && !isTrue(process.env.ALLOW_EXTERNAL_DATABASE_IN_TEST)) {
      throw new Error(
        'Refusing to run tests against a non-local database. Set TEST_DATABASE_URL to a local Postgres URL, or set ALLOW_EXTERNAL_DATABASE_IN_TEST=true to override.'
      );
    }
    return candidate;
  }

  const candidate = localDatabaseUrl || databaseUrl || LOCAL_DB_DEFAULT_URL;
  if (!isLocalDatabaseUrl(candidate) && !isTrue(process.env.ALLOW_EXTERNAL_DATABASE_IN_DEV)) {
    throw new Error(
      'Refusing to start development with a non-local database. Set LOCAL_DATABASE_URL to a local Postgres URL, or set ALLOW_EXTERNAL_DATABASE_IN_DEV=true to override.'
    );
  }

  return candidate;
}

const connectionString = resolveDatabaseConnectionString();
const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function persistErrorEvent(event = {}) {
  try {
    await pool.query(
      `
        INSERT INTO app_error_events (
          source,
          category,
          severity,
          message,
          code,
          request_id,
          path,
          method,
          user_id,
          ip_address,
          user_agent,
          stack,
          details
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      `,
      [
        event.source || 'server',
        event.category || 'runtime',
        event.severity || 'error',
        event.message || 'Unknown error',
        event.code || null,
        event.requestId || null,
        event.path || null,
        event.method || null,
        event.userId || null,
        event.ipAddress || null,
        event.userAgent || null,
        event.stack || null,
        event.details ? JSON.stringify(event.details) : null,
      ]
    );
  } catch (persistError) {
    console.error('[error-sink] Failed to persist error event', persistError);
  }
}

function sendApiError(req, res, status, code, message, details) {
  const payload = {
    error: {
      code,
      message,
      requestId: req.requestId || null,
    },
  };

  if (details && Object.keys(details).length) {
    payload.error.details = details;
  }

  return res.status(status).json(payload);
}

const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const isFutureDate = (value) => {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() > Date.now();
};

async function getAbuseBucket(scope, key) {
  const { rows } = await pool.query(
    'SELECT attempt_count, first_attempt_at, last_attempt_at, locked_until FROM auth_abuse_buckets WHERE scope = $1 AND bucket_key = $2',
    [scope, key]
  );
  return rows[0] || null;
}

async function clearAbuseBucket(scope, key) {
  await pool.query('DELETE FROM auth_abuse_buckets WHERE scope = $1 AND bucket_key = $2', [scope, key]);
}

async function registerAbuseAttempt(scope, key, { threshold, windowMinutes, lockoutMinutes }) {
  const existing = await getAbuseBucket(scope, key);
  const now = new Date();

  if (existing && isFutureDate(existing.locked_until)) {
    return { blocked: true, lockedUntil: existing.locked_until, attemptCount: Number(existing.attempt_count || 0) };
  }

  const firstAttemptAt = existing?.first_attempt_at ? new Date(existing.first_attempt_at) : null;
  const resetWindow = !firstAttemptAt || Number.isNaN(firstAttemptAt.getTime()) || (now.getTime() - firstAttemptAt.getTime()) > windowMinutes * 60 * 1000;
  const nextAttemptCount = resetWindow ? 1 : Number(existing?.attempt_count || 0) + 1;
  const nextFirstAttemptAt = resetWindow ? now : firstAttemptAt;
  const shouldLock = nextAttemptCount > threshold;
  const lockedUntil = shouldLock ? new Date(now.getTime() + lockoutMinutes * 60 * 1000) : null;

  await pool.query(
    `
      INSERT INTO auth_abuse_buckets (scope, bucket_key, attempt_count, first_attempt_at, last_attempt_at, locked_until)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (scope, bucket_key) DO UPDATE SET
        attempt_count = EXCLUDED.attempt_count,
        first_attempt_at = EXCLUDED.first_attempt_at,
        last_attempt_at = EXCLUDED.last_attempt_at,
        locked_until = EXCLUDED.locked_until
    `,
    [scope, key, nextAttemptCount, nextFirstAttemptAt, now, lockedUntil]
  );

  return { blocked: shouldLock, lockedUntil, attemptCount: nextAttemptCount };
}

async function ensureAbuseNotLocked(req, res, scope, key, code, message) {
  const state = await getAbuseBucket(scope, key);
  if (state && isFutureDate(state.locked_until)) {
    return sendApiError(req, res, 429, code, message, { lockedUntil: state.locked_until });
  }
  return null;
}

async function recordFailedLoginAttempt(userId) {
  const lockThreshold = Math.max(1, LOGIN_MAX_ATTEMPTS);
  const lockMinutes = Math.max(1, LOGIN_LOCKOUT_MINUTES);
  const { rows } = await pool.query(
    `
      UPDATE users
      SET
        failed_login_attempts = COALESCE(failed_login_attempts, 0) + 1,
        locked_until = CASE
          WHEN COALESCE(failed_login_attempts, 0) + 1 >= $2 THEN now() + ($3 * INTERVAL '1 minute')
          ELSE locked_until
        END
      WHERE id = $1
      RETURNING failed_login_attempts, locked_until
    `,
    [userId, lockThreshold, lockMinutes]
  );

  return rows[0] || null;
}

async function clearFailedLoginState(userId) {
  await pool.query(
    `
      UPDATE users
      SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now()
      WHERE id = $1
    `,
    [userId]
  );
}

async function getCurrentSessionVersion(userId) {
  const { rows } = await pool.query('SELECT session_version FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return null;
  return Number(rows[0].session_version || 0);
}

async function isUserAdmin(userId) {
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return false;
  return Boolean(rows[0].is_admin);
}

async function revokeUserSessions(userId) {
  const { rows } = await pool.query(
    'UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = $1 RETURNING session_version',
    [userId]
  );
  return rows[0] ? Number(rows[0].session_version) : null;
}

async function revokeAllRefreshSessionsForUser(userId) {
  await pool.query('UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

async function revokeRefreshSessionByToken(refreshToken, reason = 'manual_logout') {
  if (!refreshToken) return null;
  const tokenHash = hashRefreshToken(refreshToken);
  const { rows } = await pool.query(
    `
      UPDATE refresh_sessions
      SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, $2)
      WHERE token_hash = $1
      RETURNING id, user_id AS "userId"
    `,
    [tokenHash, reason]
  );
  return rows[0] || null;
}

function buildSessionMetadata(req) {
  return {
    userAgent: req.get('user-agent') || null,
    ipAddress: req.ip || null,
  };
}

async function createRefreshSession(userId, sessionVersion, metadata = {}) {
  const refreshToken = createRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken);
  const expiresAt = getRefreshTokenExpiryDate();

  await pool.query(
    `
      INSERT INTO refresh_sessions (user_id, token_hash, session_version, expires_at, user_agent, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [userId, tokenHash, sessionVersion, expiresAt, metadata.userAgent || null, metadata.ipAddress || null]
  );

  return { refreshToken, tokenHash, expiresAt };
}

async function issueAuthSession(req, res, user) {
  const sessionVersion = Number(user.session_version || 0);
  const accessToken = signAccessToken({ id: user.id, email: user.email, sessionVersion });
  const { refreshToken } = await createRefreshSession(user.id, sessionVersion, buildSessionMetadata(req));
  setAuthCookies(res, accessToken, refreshToken);
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    isVerified: user.is_verified,
    isAdmin: Boolean(user.is_admin),
    verificationMethod: user.verification_method,
    sessionIdleTimeoutMinutes: REFRESH_SESSION_IDLE_MINUTES,
  };
}

async function getUserSessions(userId, currentRefreshToken, pagination = {}) {
  const currentTokenHash = currentRefreshToken ? hashRefreshToken(currentRefreshToken) : null;
  const safeLimit = Math.min(Math.max(Number(pagination.limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(pagination.offset) || 0, 0);

  const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM refresh_sessions WHERE user_id = $1', [userId]);
  const total = Number(countResult.rows[0]?.total || 0);

  const { rows } = await pool.query(
    `
      SELECT
        id,
        created_at AS "createdAt",
        last_used_at AS "lastUsedAt",
        expires_at AS "expiresAt",
        revoked_at AS "revokedAt",
        revoked_reason AS "revokedReason",
        user_agent AS "userAgent",
        ip_address AS "ipAddress",
        token_hash = $2 AS "isCurrent"
      FROM refresh_sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $3
      OFFSET $4
    `,
    [userId, currentTokenHash, safeLimit, safeOffset]
  );

  return {
    sessions: rows.map((row) => ({
      ...row,
      status: row.revokedAt ? 'revoked' : new Date(row.expiresAt).getTime() <= Date.now() ? 'expired' : 'active',
    })),
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      total,
      hasMore: safeOffset + rows.length < total,
      nextOffset: safeOffset + rows.length < total ? safeOffset + rows.length : null,
      previousOffset: safeOffset > 0 ? Math.max(safeOffset - safeLimit, 0) : null,
    },
  };
}

async function getAdminSessions(filters = {}) {
  const whereParts = [];
  const params = [];

  if (filters.userId) {
    params.push(Number(filters.userId));
    whereParts.push(`rs.user_id = $${params.length}`);
  }

  if (filters.email) {
    params.push(String(filters.email).trim().toLowerCase());
    whereParts.push(`lower(u.email) = $${params.length}`);
  }

  if (filters.status) {
    params.push(String(filters.status).trim().toLowerCase());
    if (filters.status === 'active') {
      whereParts.push(`rs.revoked_at IS NULL AND rs.expires_at > now()`);
    } else if (filters.status === 'expired') {
      whereParts.push(`rs.revoked_at IS NULL AND rs.expires_at <= now()`);
    } else if (filters.status === 'revoked') {
      whereParts.push(`rs.revoked_at IS NOT NULL`);
    }
  }

  const safeLimit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(filters.offset) || 0, 0);
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM refresh_sessions rs JOIN users u ON u.id = rs.user_id ${whereClause}`,
    params
  );
  const total = Number(countResult.rows[0]?.total || 0);

  const queryParams = [...params, safeLimit, safeOffset];
  const { rows } = await pool.query(
    `
      SELECT
        rs.id,
        rs.user_id AS "userId",
        u.email,
        u.name,
        rs.created_at AS "createdAt",
        rs.last_used_at AS "lastUsedAt",
        rs.expires_at AS "expiresAt",
        rs.revoked_at AS "revokedAt",
        rs.revoked_reason AS "revokedReason",
        rs.user_agent AS "userAgent",
        rs.ip_address AS "ipAddress"
      FROM refresh_sessions rs
      JOIN users u ON u.id = rs.user_id
      ${whereClause}
      ORDER BY rs.created_at DESC
      LIMIT $${queryParams.length - 1}
      OFFSET $${queryParams.length}
    `,
    queryParams
  );

  return {
    sessions: rows.map((row) => ({
      ...row,
      status: row.revokedAt ? 'revoked' : new Date(row.expiresAt).getTime() <= Date.now() ? 'expired' : 'active',
    })),
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      total,
      hasMore: safeOffset + rows.length < total,
      nextOffset: safeOffset + rows.length < total ? safeOffset + rows.length : null,
      previousOffset: safeOffset > 0 ? Math.max(safeOffset - safeLimit, 0) : null,
    },
  };
}

async function recordUserConsent({ userId, policyVersion, acceptedTerms, acceptedPrivacy, source, req }) {
  await pool.query(
    `
      INSERT INTO user_legal_consents (
        user_id,
        policy_version,
        accepted_terms,
        accepted_privacy,
        source,
        ip_address,
        user_agent
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      userId,
      policyVersion,
      acceptedTerms,
      acceptedPrivacy,
      source,
      req?.ip || null,
      req?.get('user-agent') || null,
    ]
  );
}

async function queueDeletionRequest({ userId, email, reason, req }) {
  const { rows } = await pool.query(
    `
      INSERT INTO user_data_deletion_requests (
        user_id,
        email,
        reason,
        status,
        requested_by_user,
        ip_address,
        user_agent
      )
      VALUES ($1,$2,$3,'pending',true,$4,$5)
      RETURNING id, status, created_at AS "createdAt"
    `,
    [userId, email, reason || null, req?.ip || null, req?.get('user-agent') || null]
  );
  return rows[0] || null;
}

async function exportUserDataBundle(userId) {
  const userResult = await pool.query(
    `
      SELECT id, email, name, phone, is_verified AS "isVerified", verification_method AS "verificationMethod", is_admin AS "isAdmin", created_at AS "createdAt", last_login_at AS "lastLoginAt"
      FROM users
      WHERE id = $1
    `,
    [userId]
  );

  const savedReportsResult = await pool.query(
    `
      SELECT vin, make, model, year, status, theft, ownership, accidents, mileage, score, photo, saved_at AS "savedAt", selected_for_comparison AS "selectedForComparison"
      FROM saved_reports
      WHERE user_id = $1
      ORDER BY saved_at DESC
    `,
    [userId]
  );

  const sessionsResult = await pool.query(
    `
      SELECT id, created_at AS "createdAt", last_used_at AS "lastUsedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt", revoked_reason AS "revokedReason", user_agent AS "userAgent", ip_address AS "ipAddress"
      FROM refresh_sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
    `,
    [userId]
  );

  const auditResult = await pool.query(
    `
      SELECT event_type AS "eventType", success, failure_code AS "failureCode", request_id AS "requestId", ip_address AS "ipAddress", user_agent AS "userAgent", details, created_at AS "createdAt"
      FROM auth_audit_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
    `,
    [userId]
  );

  const consentResult = await pool.query(
    `
      SELECT policy_version AS "policyVersion", accepted_terms AS "acceptedTerms", accepted_privacy AS "acceptedPrivacy", source, ip_address AS "ipAddress", user_agent AS "userAgent", created_at AS "createdAt"
      FROM user_legal_consents
      WHERE user_id = $1
      ORDER BY created_at DESC
    `,
    [userId]
  );

  return {
    exportedAt: new Date().toISOString(),
    user: userResult.rows[0] || null,
    savedReports: savedReportsResult.rows,
    sessions: sessionsResult.rows,
    authAudit: auditResult.rows,
    legalConsents: consentResult.rows,
  };
}

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getAuthAlertConfig(eventType) {
  if (eventType === 'AUTH_ACCOUNT_LOCKED') {
    return {
      alertType: 'LOCKOUT_THRESHOLD_EXCEEDED',
      severity: 'warning',
      threshold: LOCKOUT_ALERT_THRESHOLD,
      windowMinutes: AUTH_ALERT_WINDOW_MINUTES,
    };
  }

  if (eventType === 'AUTH_REFRESH_REUSED') {
    return {
      alertType: 'REFRESH_TOKEN_REUSE_DETECTED',
      severity: 'critical',
      threshold: REFRESH_REUSE_ALERT_THRESHOLD,
      windowMinutes: AUTH_ALERT_WINDOW_MINUTES,
    };
  }

  return null;
}

function buildAuthAlertSubject({ userId, email, phone, ipAddress }) {
  if (userId) return { subjectKey: `user:${userId}`, subjectLabel: `user:${userId}` };
  if (email) return { subjectKey: `email:${String(email).toLowerCase()}`, subjectLabel: String(email).toLowerCase() };
  if (phone) return { subjectKey: `phone:${phone}`, subjectLabel: phone };
  if (ipAddress) return { subjectKey: `ip:${ipAddress}`, subjectLabel: ipAddress };
  return { subjectKey: 'unknown', subjectLabel: 'unknown' };
}

async function logAlertDeliveryAttempt({
  alertId,
  channel,
  destination,
  attemptNumber,
  success,
  responseStatus = null,
  errorMessage = null,
}) {
  await pool.query(
    `
      INSERT INTO auth_alert_delivery_logs (
        alert_id,
        channel,
        destination,
        attempt_number,
        success,
        response_status,
        error_message
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [alertId, channel, destination, attemptNumber, success, responseStatus, errorMessage]
  );
}

async function deliverAlertNotification({ alert, channel, destination, requestFactory }) {
  let attempt = 0;
  while (attempt < AUTH_ALERT_DELIVERY_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const response = await requestFactory();
      if (!response.ok) {
        const errorText = (await response.text().catch(() => '')).slice(0, 500);
        await logAlertDeliveryAttempt({
          alertId: alert.id,
          channel,
          destination,
          attemptNumber: attempt,
          success: false,
          responseStatus: response.status,
          errorMessage: errorText || `HTTP ${response.status}`,
        });
        if (attempt < AUTH_ALERT_DELIVERY_MAX_ATTEMPTS) {
          await waitFor(AUTH_ALERT_DELIVERY_BASE_DELAY_MS * (2 ** (attempt - 1)));
          continue;
        }
        console.error(`[auth-alert:${alert.id}] ${channel} delivery failed with HTTP ${response.status}`);
        return false;
      }

      await logAlertDeliveryAttempt({
        alertId: alert.id,
        channel,
        destination,
        attemptNumber: attempt,
        success: true,
        responseStatus: response.status,
      });
      return true;
    } catch (error) {
      await logAlertDeliveryAttempt({
        alertId: alert.id,
        channel,
        destination,
        attemptNumber: attempt,
        success: false,
        errorMessage: error.message,
      });
      if (attempt < AUTH_ALERT_DELIVERY_MAX_ATTEMPTS) {
        await waitFor(AUTH_ALERT_DELIVERY_BASE_DELAY_MS * (2 ** (attempt - 1)));
        continue;
      }
      console.error(`[auth-alert:${alert.id}] ${channel} delivery failed`, error);
      return false;
    }
  }

  return false;
}

async function evaluateAuthAlertThreshold({ eventType, userId, email, phone, ipAddress }) {
  const config = getAuthAlertConfig(eventType);
  if (!config) return;

  const { subjectKey, subjectLabel } = buildAuthAlertSubject({ userId, email, phone, ipAddress });
  const params = [eventType, config.windowMinutes];
  const whereParts = ['event_type = $1', `created_at >= now() - ($2 * INTERVAL '1 minute')`];

  if (userId) {
    params.push(userId);
    whereParts.push(`user_id = $${params.length}`);
  } else if (email) {
    params.push(String(email).toLowerCase());
    whereParts.push(`lower(email) = $${params.length}`);
  } else if (phone) {
    params.push(phone);
    whereParts.push(`phone = $${params.length}`);
  } else if (ipAddress) {
    params.push(ipAddress);
    whereParts.push(`ip_address = $${params.length}`);
  }

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS event_count FROM auth_audit_logs WHERE ${whereParts.join(' AND ')}`,
    params
  );
  const eventCount = Number(countRows[0]?.event_count || 0);
  if (eventCount < config.threshold) return;

  const { rows: existingRows } = await pool.query(
    `
      SELECT id
      FROM auth_security_alerts
      WHERE alert_type = $1
        AND subject_key = $2
        AND created_at >= now() - ($3 * INTERVAL '1 minute')
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [config.alertType, subjectKey, config.windowMinutes]
  );
  if (existingRows[0]) return;

  const { rows: alertRows } = await pool.query(
    `
      INSERT INTO auth_security_alerts (
        alert_type,
        severity,
        status,
        subject_key,
        subject_label,
        event_count,
        threshold,
        window_minutes,
        details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      RETURNING id, alert_type AS "alertType", severity, status, subject_key AS "subjectKey", subject_label AS "subjectLabel", event_count AS "eventCount", threshold, window_minutes AS "windowMinutes", details, created_at AS "createdAt"
    `,
    [
      config.alertType,
      config.severity,
      'open',
      subjectKey,
      subjectLabel,
      eventCount,
      config.threshold,
      config.windowMinutes,
      JSON.stringify({ eventType, userId, email, phone, ipAddress }),
    ]
  );

  const alert = alertRows[0];

  const alertSummary = `${alert.alertType} (${alert.severity}) for ${subjectLabel}`;
  const alertDetailsText = JSON.stringify(alert.details || {});

  const notificationTasks = [];
  if (AUTH_ALERT_WEBHOOK_URL) {
    notificationTasks.push(
      deliverAlertNotification({
        alert,
        channel: 'webhook',
        destination: AUTH_ALERT_WEBHOOK_URL,
        requestFactory: () => fetch(AUTH_ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'vinscope-kenya',
            category: 'auth_security_alert',
            alert,
          }),
        }),
      })
    );
  }

  if (AUTH_ALERT_SLACK_WEBHOOK_URL) {
    notificationTasks.push(
      deliverAlertNotification({
        alert,
        channel: 'slack',
        destination: AUTH_ALERT_SLACK_WEBHOOK_URL,
        requestFactory: () => fetch(AUTH_ALERT_SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `[${alert.severity.toUpperCase()}] ${alertSummary}\nCount: ${alert.eventCount}/${alert.threshold} in ${alert.windowMinutes} minutes\nDetails: ${alertDetailsText}`,
          }),
        }),
      })
    );
  }

  if (RESEND_API_KEY && AUTH_ALERT_EMAIL_FROM && AUTH_ALERT_EMAIL_TO.length) {
    notificationTasks.push(
      deliverAlertNotification({
        alert,
        channel: 'email',
        destination: AUTH_ALERT_EMAIL_TO.join(','),
        requestFactory: () => fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: AUTH_ALERT_EMAIL_FROM,
            to: AUTH_ALERT_EMAIL_TO,
            subject: `[${alert.severity.toUpperCase()}] ${alert.alertType}`,
            text: `${alertSummary}\nCount: ${alert.eventCount}/${alert.threshold} in ${alert.windowMinutes} minutes\nDetails: ${alertDetailsText}`,
          }),
        }),
      })
    );
  }

  await Promise.allSettled(notificationTasks);

  console.warn(`[auth-alert] ${config.alertType} for ${subjectLabel} (${eventCount} events in ${config.windowMinutes} minutes)`);
}

const requireAdmin = asyncHandler(async (req, res, next) => {
  const allowed = await isUserAdmin(req.user.id);
  if (!allowed) {
    return sendApiError(req, res, 403, 'ADMIN_REQUIRED', 'Administrator access required');
  }

  next();
});
async function recordAuthAudit(req, {
  eventType,
  userId = null,
  email = null,
  phone = null,
  success = true,
  failureCode = null,
  details = null,
}) {
  try {
    const ipAddress = req.ip || null;
    await pool.query(
      `
        INSERT INTO auth_audit_logs (
          event_type,
          user_id,
          email,
          phone,
          success,
          failure_code,
          request_id,
          ip_address,
          user_agent,
          details
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        eventType,
        userId,
        email,
        phone,
        success,
        failureCode,
        req.requestId || null,
        ipAddress,
        req.get('user-agent') || null,
        details ? JSON.stringify(details) : null,
      ]
    );

    await evaluateAuthAlertThreshold({ eventType, userId, email, phone, ipAddress });
  } catch (error) {
    console.error(`[${req.requestId || 'no-request-id'}] Failed to write auth audit log`, error);
  }
}

const escapeCsvValue = (value) => {
  if (value == null) return '';
  const normalized = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
};

async function rotateRefreshSession(res, refreshToken) {
  const tokenHash = hashRefreshToken(refreshToken);
  const { rows } = await pool.query(
    `
      SELECT
        rs.id,
        rs.user_id,
        rs.session_version,
        rs.expires_at,
        rs.created_at,
        rs.last_used_at,
        rs.revoked_at,
        rs.replaced_by_token_hash,
        u.email,
        u.name,
        u.is_verified,
        u.is_admin,
        u.verification_method,
        u.session_version AS current_session_version
      FROM refresh_sessions rs
      JOIN users u ON u.id = rs.user_id
      WHERE rs.token_hash = $1
    `,
    [tokenHash]
  );

  const session = rows[0];
  if (!session) {
    return { ok: false, code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is invalid.' };
  }

  if (session.revoked_at) {
    await revokeUserSessions(session.user_id);
    await revokeAllRefreshSessionsForUser(session.user_id);
    return { ok: false, code: 'REFRESH_TOKEN_REUSED', message: 'Refresh token reuse detected. Please sign in again.', userId: session.user_id };
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await pool.query('UPDATE refresh_sessions SET revoked_at = now() WHERE id = $1', [session.id]);
    return { ok: false, code: 'REFRESH_TOKEN_EXPIRED', message: 'Refresh token has expired. Please sign in again.', userId: session.user_id };
  }

  const lastActivityAt = session.last_used_at || session.created_at;
  if (lastActivityAt) {
    const idleCutoff = Date.now() - (REFRESH_SESSION_IDLE_MINUTES * 60 * 1000);
    const lastActivityTime = new Date(lastActivityAt).getTime();
    if (!Number.isNaN(lastActivityTime) && lastActivityTime < idleCutoff) {
      await pool.query('UPDATE refresh_sessions SET revoked_at = now() WHERE id = $1', [session.id]);
      return {
        ok: false,
        code: 'REFRESH_SESSION_IDLE_EXPIRED',
        message: 'Your session expired after inactivity. Please sign in again.',
        userId: session.user_id,
      };
    }
  }

  if (Number(session.current_session_version || 0) !== Number(session.session_version || 0)) {
    await revokeAllRefreshSessionsForUser(session.user_id);
    return { ok: false, code: 'SESSION_REVOKED', message: 'Your session is no longer valid. Please sign in again.', userId: session.user_id };
  }

  const nextRefreshSession = await createRefreshSession(session.user_id, Number(session.current_session_version || 0), buildSessionMetadata(req));
  await pool.query(
    `
      UPDATE refresh_sessions
      SET revoked_at = now(), replaced_by_token_hash = $2, last_used_at = now()
      WHERE id = $1
    `,
    [session.id, nextRefreshSession.tokenHash]
  );

  const accessToken = signAccessToken({
    id: session.user_id,
    email: session.email,
    sessionVersion: Number(session.current_session_version || 0),
  });
  setAuthCookies(res, accessToken, nextRefreshSession.refreshToken);

  return {
    ok: true,
    user: {
      id: session.user_id,
      email: session.email,
      name: session.name,
      isVerified: session.is_verified,
      isAdmin: session.is_admin,
      verificationMethod: session.verification_method,
    },
  };
}

setSessionVersionResolver(getCurrentSessionVersion);

function validateEnvironment() {
  const warnings = [];

  const parsedConnectionString = parseDbUrl(connectionString);
  if (!parsedConnectionString) {
    throw new Error('Invalid database URL. Use a full postgres or postgresql connection URL.');
  }

  if (process.env.NODE_ENV !== 'production') {
    warnings.push(`Using database host: ${parsedConnectionString.hostname}`);
  }

  if (!String(process.env.JWT_SECRET || '').trim()) {
    warnings.push('JWT_SECRET is empty. A random runtime secret will be generated, which invalidates sessions after restart.');
  }

  const mpesaStatus = getMpesaConfigStatus();
  if (mpesaStatus.partiallyConfigured) {
    warnings.push(`M-Pesa is partially configured. Missing: ${mpesaStatus.missing.join(', ')}. STK push will fall back to demo mode.`);
  }

  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (publicBaseUrl && !publicBaseUrl.startsWith('https://')) {
    warnings.push('PUBLIC_BASE_URL should be HTTPS for M-Pesa callbacks.');
  }

  if (process.env.NODE_ENV === 'production') {
    warnings.push(`Auth cookies enforced as secure=${AUTH_COOKIE_POLICY.secure}, httpOnly=${AUTH_COOKIE_POLICY.httpOnly}, sameSite=${AUTH_COOKIE_POLICY.sameSite}.`);
  }

  for (const warning of warnings) {
    console.warn(`[env] ${warning}`);
  }
}

validateEnvironment();

const seedVehicles = [
  {
    vin: 'JTEBU5JR3K5001234',
    make: 'Toyota',
    model: 'Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'WVWZZZ1JZ3W123456',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 91,
    source: 'postgres-seed',
  },
  {
    vin: '1HGCM82633A004352',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2003,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Odometer rollback suspected - readings decreased between service records',
    score: 57,
    source: 'postgres-seed',
  },
  {
    vin: '1C3CCCAB3FN123456',
    make: 'Chrysler',
    model: '300',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg/500px-2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: '2T2BK1BA5KC123456',
    make: 'Toyota',
    model: 'Camry',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg/500px-2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: '5YJ3E1EA7KF123456',
    make: 'Tesla',
    model: 'Model 3',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg/500px-Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 95,
    source: 'postgres-seed',
  },
  {
    vin: '3VWJP7AT5KM123456',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Gap detected between mileage recordings - unexplained interval with no data',
    score: 70,
    source: 'postgres-seed',
  },
  {
    vin: 'WBA3B5C50FK123456',
    make: 'BMW',
    model: '330i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'TRUWT28N82K123456',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2002,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 54,
    source: 'postgres-seed',
  },
  {
    vin: 'SALWA2BE7HA123456',
    make: 'Land Rover',
    model: 'Evoque',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/2019_Land_Rover_Range_Rover_Evoque_R-Dynamic_2.0.jpg/500px-2019_Land_Rover_Range_Rover_Evoque_R-Dynamic_2.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'JHMGK8H34MC123456',
    make: 'Honda',
    model: 'Civic',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg/500px-Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 92,
    source: 'postgres-seed',
  },
  {
    vin: 'WAUZZZ8G9DA123456',
    make: 'Audi',
    model: 'A4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg/500px-Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Gap detected between mileage recordings - unexplained interval with no data',
    score: 66,
    source: 'postgres-seed',
  },
  {
    vin: 'MBHDC9EAXPC123456',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: 'JTD4LZRGMCZ435SSD',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'JTE13HJW1DXGLJ9KD',
    make: 'Toyota',
    model: 'Land Cruiser Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'JTMRVTT1459XZFBCL',
    make: 'Toyota',
    model: 'RAV4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg/500px-2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Odometer reading unchanged across multiple recorded services',
    score: 63,
    source: 'postgres-seed',
  },
  {
    vin: 'JT2UP2HWWJ0LUW7F1',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'JTNPKZBB27GHGG46X',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'JN1AEAXH270V9AH2L',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'JN8VGLRLC7HK781US',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Odometer reading unchanged across multiple recorded services',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'SJNPC6AB3AZ5WGTUG',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'JHMPF2M5WFB4MW43N',
    make: 'Honda',
    model: 'Fit',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg/500px-Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: '1HGPV69MKHL1D9EEX',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Odometer rollback suspected - readings decreased between service records',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'JM1P2XZSGHWSZ9128',
    make: 'Mazda',
    model: 'Demio',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg/500px-Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 69,
    source: 'postgres-seed',
  },
  {
    vin: 'JM7F7TW9BLPHTA6AU',
    make: 'Mazda',
    model: 'CX-5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg/500px-2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JA4ZDFR8LG0SXV0VU',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JA3HLE78B585D4SKD',
    make: 'Mitsubishi',
    model: 'Pajero',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG/500px-Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 70,
    source: 'postgres-seed',
  },
  {
    vin: 'JF1203PYM55V11MAC',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'JF27GU6995UY4RLHP',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'JS2L1DJLHH7427N27',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 71,
    source: 'postgres-seed',
  },
  {
    vin: 'JS3PFCCJZJCCNCE09',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 95,
    source: 'postgres-seed',
  },
  {
    vin: 'JAAPUVHPZE5YYVVGS',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'WVW50VVT3FM7JMPMG',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 71,
    source: 'postgres-seed',
  },
  {
    vin: '3VWFM81A1JEYTUYXY',
    make: 'Volkswagen',
    model: 'Tiguan',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg/500px-Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Needs review',
    theft: 'Flagged - recovered vehicle',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 58,
    source: 'postgres-seed',
  },
  {
    vin: 'WBAZLY648H5P3UMMW',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'WBSPNDUL2BNWVZTFW',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'WDDP7ACNX9J10WK54',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2012,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'MBHZPMHZB27LZ79WM',
    make: 'Mercedes-Benz',
    model: 'GLC',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Mercedes-Benz_X254_1X7A6343.jpg/500px-Mercedes-Benz_X254_1X7A6343.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 64,
    source: 'postgres-seed',
  },
  {
    vin: 'WAUSGRS09JX7E1JHT',
    make: 'Audi',
    model: 'Q5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg/500px-Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'SALXP1TDYL4RF7RRF',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 61,
    source: 'postgres-seed',
  },
  {
    vin: '1FADW95UNDPT1C9AA',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'MAJAZBD3HLNP23Y3D',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'KMHSER3JDCNJ5HPGD',
    make: 'Hyundai',
    model: 'Tucson',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c6/2022_Hyundai_Tucson_Preferred%2C_Front_Right%2C_05-24-2021.jpg/500px-2022_Hyundai_Tucson_Preferred%2C_Front_Right%2C_05-24-2021.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'KNASP62BD7W904KNS',
    make: 'Kia',
    model: 'Sportage',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/2025_Kia_Sportage_S_front_only.jpg/500px-2025_Kia_Sportage_S_front_only.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 67,
    source: 'postgres-seed',
  },
  {
    vin: 'VF3SS0TT0AXRXCP39',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: 'YV16VDL3XHPZ2VVHF',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '5YJKUSGRA2LP44PYS',
    make: 'Tesla',
    model: 'Model 3',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg/500px-Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 63,
    source: 'postgres-seed',
  },
  {
    vin: '1J40241UKJGYYFS42',
    make: 'Jeep',
    model: 'Grand Cherokee',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg/500px-2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: '1G1UAUZG8BEE6UB3E',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'JTDK4PNFRALNRC4NG',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'JTE28KWKA5APDXFVM',
    make: 'Toyota',
    model: 'Land Cruiser Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JTM23L9PXJKXR1051',
    make: 'Toyota',
    model: 'RAV4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg/500px-2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 64,
    source: 'postgres-seed',
  },
  {
    vin: 'JT21C3MZED90BPY8H',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 58,
    source: 'postgres-seed',
  },
  {
    vin: 'JTNDL7NNDGPBRD7VF',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'JN1BA5U14GP0YF0VD',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'JN8RTFASJHZXYYGHG',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'SJNXKNTN95RPY1EFP',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 97,
    source: 'postgres-seed',
  },
  {
    vin: 'JHMAWZZGDCXGJ8STN',
    make: 'Honda',
    model: 'Fit',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg/500px-Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: '1HG0FR7SUGHKK7UHP',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 92,
    source: 'postgres-seed',
  },
  {
    vin: 'JM1KNPVKW37KR6PMJ',
    make: 'Mazda',
    model: 'Demio',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg/500px-Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JM7LFNU28E00TM9CW',
    make: 'Mazda',
    model: 'CX-5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg/500px-2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 60,
    source: 'postgres-seed',
  },
  {
    vin: 'JA45JC97H80GUSZ6F',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'JA3XRZ0H3LX9ZX7HR',
    make: 'Mitsubishi',
    model: 'Pajero',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG/500px-Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'JF1RN0H2DJWF6PAND',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'JF2AHZ4PZAHFV9TL6',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JS27FVTA1K27GXZZ3',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'JS361KNVAL193RY0T',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 96,
    source: 'postgres-seed',
  },
  {
    vin: 'JAA9AD260B0S0NBHN',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'WVWD6ZMBHCXKT6Y5Y',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: '3VWXAFUEFKRGSBT5F',
    make: 'Volkswagen',
    model: 'Tiguan',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg/500px-Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 69,
    source: 'postgres-seed',
  },
  {
    vin: 'WBAG9D3XNCKYNDN8R',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'WBSEV8UZT4BFACP7F',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'WDDLCJFVZJJLNZZZK',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 97,
    source: 'postgres-seed',
  },
  {
    vin: 'MBHTEKK5R5HJJ8C8B',
    make: 'Mercedes-Benz',
    model: 'GLC',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Mercedes-Benz_X254_1X7A6343.jpg/500px-Mercedes-Benz_X254_1X7A6343.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'WAUYL91AM8UM7PFE7',
    make: 'Audi',
    model: 'Q5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg/500px-Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'SAL797ZZJ70H0M5NS',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 66,
    source: 'postgres-seed',
  },
  {
    vin: '1FAELAVAD7XMT3PPJ',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: 'MAJRSCRPBH5CDZ1SP',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'KMH1P62N2FNP8Y8F4',
    make: 'Hyundai',
    model: 'Tucson',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c6/2022_Hyundai_Tucson_Preferred%2C_Front_Right%2C_05-24-2021.jpg/500px-2022_Hyundai_Tucson_Preferred%2C_Front_Right%2C_05-24-2021.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'KNAYHF0XJKM83ZX5M',
    make: 'Kia',
    model: 'Sportage',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/2025_Kia_Sportage_S_front_only.jpg/500px-2025_Kia_Sportage_S_front_only.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'VF3ZJYN30CVASKN9F',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'YV1WH6BV7AA05K5MX',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: '5YJ18NW93ECSNM91H',
    make: 'Tesla',
    model: 'Model 3',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg/500px-Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 95,
    source: 'postgres-seed',
  },
  {
    vin: '1J4UD996S24YD9TWE',
    make: 'Jeep',
    model: 'Grand Cherokee',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg/500px-2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: '1G1PD0LUR6C3TZ7FS',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'JTD9G5GBMDA0XUGHP',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 47,
    source: 'postgres-seed',
  },
  {
    vin: 'JTE6E3N0NDUA43PSL',
    make: 'Toyota',
    model: 'Land Cruiser Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'JTM4PV7WSK23F1NVV',
    make: 'Toyota',
    model: 'RAV4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg/500px-2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'JT20ZD27L8GCHJURD',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'JTN2RT54FKZFR6DHW',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 91,
    source: 'postgres-seed',
  },
  {
    vin: 'JN11KU9DX8KW3H189',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'JN8BB3WLV6DM1MHPK',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'SJNB9AUTBJE4GVRFE',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 64,
    source: 'postgres-seed',
  },
  {
    vin: 'JHMCP807C3MMUDMT7',
    make: 'Honda',
    model: 'Fit',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg/500px-Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 64,
    source: 'postgres-seed',
  },
  {
    vin: '1HG51RLLS36YGWLVJ',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 97,
    source: 'postgres-seed',
  },
  {
    vin: 'JM1JZM246GKPWRYHV',
    make: 'Mazda',
    model: 'Demio',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg/500px-Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JM7238GNCFTVS6HVX',
    make: 'Mazda',
    model: 'CX-5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg/500px-2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'JA49VMHN5KXB4GDGY',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'JA3CUCRKJAE84LWM2',
    make: 'Mitsubishi',
    model: 'Pajero',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG/500px-Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'JF1E80KDC3JA3S0M2',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 95,
    source: 'postgres-seed',
  },
  {
    vin: 'JF26N8XFVBM6CNLRV',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'JS2MD1SWM5M9P2CUR',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'JS3LV240NE8AGGRKS',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 69,
    source: 'postgres-seed',
  },
  {
    vin: 'JAAXV0MEAKCVRTUEK',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 67,
    source: 'postgres-seed',
  },
  {
    vin: 'WVWRDYPXHKB1RCNCT',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '3VWN91YZ6DGYMF605',
    make: 'Volkswagen',
    model: 'Tiguan',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg/500px-Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 92,
    source: 'postgres-seed',
  },
  {
    vin: 'WBAN8SKLNFL104CJU',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 97,
    source: 'postgres-seed',
  },
  {
    vin: 'WBSP1UY3WHZVF6TCW',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'WDDVPWPWPGWF8SN84',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'MBH61YP6WDN7H1SH0',
    make: 'Mercedes-Benz',
    model: 'GLC',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Mercedes-Benz_X254_1X7A6343.jpg/500px-Mercedes-Benz_X254_1X7A6343.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'WAURXC3U3JY7UZT10',
    make: 'Audi',
    model: 'Q5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg/500px-Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'SALTAWCYN3B5WTA24',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 70,
    source: 'postgres-seed',
  },
  {
    vin: '1FA96ACGDCJDMN25F',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'U1JNG9TUJD36RJJGL',
    make: 'Toyota',
    model: 'Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'SSRHAA972V2XMNJMY',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2012,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: '9VC9R0GU9GZPR1F33',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'D9M2JY7SR7S9L351V',
    make: 'Mazda',
    model: 'CX-5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg/500px-2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'CTSA0NR7ERKPJN07A',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'WMJNLXGK9GYT2EMHK',
    make: 'Chrysler',
    model: '300',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg/500px-2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'RLMD1PAMUG5783HTG',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '99ENBUFTF3JHM1P8V',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'VXMNH3SYTBXZF3HBS',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 58,
    source: 'postgres-seed',
  },
  {
    vin: '7VB1JXASX6M68RS6A',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'E239RCR98PL93NLC7',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'R10JR3XT33JHYHNHX',
    make: 'Audi',
    model: 'A4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg/500px-Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'ADJZ4UA3NEFNBJZGB',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Needs review',
    theft: 'Flagged - recovered vehicle',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 57,
    source: 'postgres-seed',
  },
  {
    vin: 'KUYHPWWJZMTTM025R',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'UA7VG1MREEL71Z1MS',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'M576MLJV235NCGLZ3',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 57,
    source: 'postgres-seed',
  },
  {
    vin: 'JL81PSECG41LAAHJX',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'VGBUUTE6613UKHC9G',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: '9C86329JNFES52DG6',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '9SHX2UZLXP6WR3R8J',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '17L5JV3P1WBY41HXG',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '1PMS318HX4ENMKRGY',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 68,
    source: 'postgres-seed',
  },
  {
    vin: 'FCKH6CCPL2PYEF754',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'KPZBT4ZU61RHW3AJW',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: '2L0FBZR9LX4V41UC8',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: 'YEAJ1BZ0TU0RXB38W',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2024,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'U27ZL8XADAA9J25BC',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'ESLMADBYB3A1UMD0L',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 72,
    source: 'postgres-seed',
  },
  {
    vin: 'KRVRLKDRE4RXR2UKP',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'ZB2VMGLVC0AKFTTLU',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'MCNT37LYR330RJY9D',
    make: 'Kia',
    model: 'Sportage',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/2025_Kia_Sportage_S_front_only.jpg/500px-2025_Kia_Sportage_S_front_only.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: '5MFBL17GYUYMDCSYM',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: 'No major accidents',
    mileage: 'Odometer rollback suspected - readings decreased between service records',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'D22TBMXE6LZY6R15C',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'P9PXFHCMAC8L79DFW',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'LRJJFTWFSBGBJE3L7',
    make: 'Toyota',
    model: 'Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'CV5AMBECJA6HBKHZB',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'H4V19SNVERSXGN1UZ',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'XAH1TRNZBDZARKTN8',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: '80H3FB0ZAZS6WTWVX',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2024,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '4 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 63,
    source: 'postgres-seed',
  },
  {
    vin: '4HUCKNJH4DKFHGRWA',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: '7V2GUJ1WP5ZZ8NAS7',
    make: 'Mercedes-Benz',
    model: 'GLC',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Mercedes-Benz_X254_1X7A6343.jpg/500px-Mercedes-Benz_X254_1X7A6343.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'BBMNAEK5DL7C2PXCV',
    make: 'Audi',
    model: 'A4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg/500px-Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: '6GGWHRY8R6F1G9P1W',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'NNBJY5DEPC8TE75S9',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: '95919C6G8EL3HL2P3',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: '9UY75RPVG2NAXS0L9',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'W06HVKZW9KUU9KS5K',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'U47YV2FUJRDNMU7PG',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'GG8V3DMW7GSC6DS09',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Needs review',
    theft: 'Flagged - recovered vehicle',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 68,
    source: 'postgres-seed',
  },
  {
    vin: 'HHVMM21FTJ48EJYE5',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'J80GCL2DFUEF9MHWU',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: '32JVMGFKP98EZSMH3',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'KFT9MABT7S38DJ37V',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'AGY35Z0M3YTVYY2ZX',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'TZVSB6CHV96V5HZ46',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'LDNMF6GJL0GC6Z8FP',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: '7VZGNVB2VFZ8WFVSL',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'GMTB3Y8JU92XGYDPR',
    make: 'Honda',
    model: 'Fit',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg/500px-Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Needs review',
    theft: 'Flagged - recovered vehicle',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 62,
    source: 'postgres-seed',
  },
  {
    vin: '5D722CD1S1DN46FLA',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'U87KWCK5XCXRYZC5H',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2012,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: '9JJZNG5CB2FP46464',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Odometer reading unchanged across multiple recorded services',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'LYJED0HP856K88EUM',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'XN1FDA2M95RZ8KGJ5',
    make: 'Mitsubishi',
    model: 'Pajero',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG/500px-Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'YB66ZD7ATA7P411ML',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'XPY7CZ677JH5RTK0X',
    make: 'Toyota',
    model: 'Camry',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg/500px-2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'UM2S5JL2KK7368FBP',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'CP41S0RZJYHFAK9YS',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'UHTU7DGYR2BL5SK67',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: '0X0Z6K5CNU96S7X9V',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'N90SS9C2RCVX4MNJY',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'Y71A7TAY5XUBKPJ15',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'AR5H2SUW0Y62J0CJ5',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'W0FF4R2WBCYJ4LXZC',
    make: 'Chrysler',
    model: '300',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg/500px-2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'F4DXTTT7U68VGCVJW',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: '6MBSBFJSXS388W5EV',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'JBDGB5J8GYNRDDFXH',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: 'FG5U25KLBA11HHS5B',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'K1S4679YU4RKX0SD7',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Odometer reading unchanged across multiple recorded services',
    score: 50,
    source: 'postgres-seed',
  },
  {
    vin: '455KR8T57DS4S31VN',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'Z1J77J732UT4GY3FT',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'SCTZNF3MGS4DSDHU2',
    make: 'Honda',
    model: 'Civic',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg/500px-Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'DSDB1297VPDGSFH05',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'X1BS1U24PZWXU649F',
    make: 'Jeep',
    model: 'Grand Cherokee',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg/500px-2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: '2FT438R78V7F45UTR',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Gap detected between mileage recordings - unexplained interval with no data',
    score: 59,
    source: 'postgres-seed',
  },
  {
    vin: '4RZKEN7D65D60472N',
    make: 'Jeep',
    model: 'Grand Cherokee',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg/500px-2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: 'U5ZVAZAG319ZDMSSL',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2024,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'DMFXD3PA5LJYYGUTK',
    make: 'Toyota',
    model: 'Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'ZCU21420DS3EJS8E1',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'ZN97KVGT9GGZV3L0K',
    make: 'Honda',
    model: 'Civic',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg/500px-Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'ABZYH1YTX29LU4WUJ',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'FDCKJL2YCB3GFU9R4',
    make: 'Audi',
    model: 'A4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg/500px-Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: '5HCACV81MDZ23G0R2',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: 'LUS1X7JG2LFBDFHBY',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: '2SXHPCKP8TMDFLDW8',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 72,
    source: 'postgres-seed',
  },
  {
    vin: 'FNTBSUCM7DEF97MU2',
    make: 'Volkswagen',
    model: 'Tiguan',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg/500px-Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2012,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'RFFUC58T64MMYSVM3',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: '84CVVC6A1Y46K8MGG',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: '2B1PBYBW5U6LBNPSK',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'G95RLFCYZ32F0T86H',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'JRRB6WPPT8PC82MLJ',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
];

const initializeDatabase = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      vin VARCHAR(30) UNIQUE NOT NULL,
      make VARCHAR(100) NOT NULL,
      model VARCHAR(100) NOT NULL,
      year INTEGER,
      status VARCHAR(50) NOT NULL,
      theft VARCHAR(150) NOT NULL,
      ownership VARCHAR(150) NOT NULL,
      accidents VARCHAR(150) NOT NULL,
      mileage VARCHAR(150) NOT NULL,
      score INTEGER,
      source VARCHAR(100) NOT NULL DEFAULT 'postgres',
      manufacturer VARCHAR(150),
      plant_country VARCHAR(100),
      body_class VARCHAR(100),
      vehicle_type VARCHAR(100),
      fuel_type VARCHAR(100),
      engine_cylinders VARCHAR(20),
      displacement_l VARCHAR(20),
      history_available BOOLEAN NOT NULL DEFAULT true,
      photo TEXT
    );
  `);

  // Relax/extend constraints for tables created before real-VIN (NHTSA) support was added.
  await pool.query('ALTER TABLE vehicles ALTER COLUMN year DROP NOT NULL;');
  await pool.query('ALTER TABLE vehicles ALTER COLUMN score DROP NOT NULL;');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(150);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS plant_country VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS body_class VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS engine_cylinders VARCHAR(20);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS displacement_l VARCHAR(20);');
  await pool.query("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS history_available BOOLEAN NOT NULL DEFAULT true;");
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS photo TEXT;');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(150) NOT NULL,
      is_verified BOOLEAN NOT NULL DEFAULT false,
      verification_method VARCHAR(20) NOT NULL DEFAULT 'email',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_method VARCHAR(20) NOT NULL DEFAULT 'email';");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL;');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_legal_consents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      policy_version VARCHAR(64) NOT NULL,
      accepted_terms BOOLEAN NOT NULL,
      accepted_privacy BOOLEAN NOT NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'register',
      ip_address VARCHAR(120),
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS user_legal_consents_user_created_idx ON user_legal_consents (user_id, created_at DESC);');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_data_deletion_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email VARCHAR(255),
      reason TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      requested_by_user BOOLEAN NOT NULL DEFAULT true,
      ip_address VARCHAR(120),
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolution_note TEXT
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS user_data_deletion_requests_status_created_idx ON user_data_deletion_requests (status, created_at DESC);');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_error_events (
      id SERIAL PRIMARY KEY,
      source VARCHAR(40) NOT NULL,
      category VARCHAR(80) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'error',
      message TEXT NOT NULL,
      code VARCHAR(80),
      request_id VARCHAR(100),
      path TEXT,
      method VARCHAR(20),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ip_address VARCHAR(120),
      user_agent TEXT,
      stack TEXT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS app_error_events_created_idx ON app_error_events (created_at DESC);');
  await pool.query('CREATE INDEX IF NOT EXISTS app_error_events_source_category_idx ON app_error_events (source, category, created_at DESC);');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_abuse_buckets (
      scope VARCHAR(80) NOT NULL,
      bucket_key VARCHAR(255) NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_until TIMESTAMPTZ,
      PRIMARY KEY (scope, bucket_key)
    );
  `);
  if (ADMIN_EMAILS.length) {
    await pool.query('UPDATE users SET is_admin = true WHERE lower(email) = ANY($1::text[])', [ADMIN_EMAILS]);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_audit_logs (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(80) NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email VARCHAR(255),
      phone VARCHAR(20),
      success BOOLEAN NOT NULL DEFAULT true,
      failure_code VARCHAR(80),
      request_id VARCHAR(100),
      ip_address VARCHAR(120),
      user_agent TEXT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS auth_audit_logs_event_created_idx ON auth_audit_logs (event_type, created_at DESC);');
  await pool.query('CREATE INDEX IF NOT EXISTS auth_audit_logs_user_created_idx ON auth_audit_logs (user_id, created_at DESC);');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_security_alerts (
      id SERIAL PRIMARY KEY,
      alert_type VARCHAR(80) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'warning',
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      subject_key VARCHAR(255) NOT NULL,
      subject_label VARCHAR(255) NOT NULL,
      event_count INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      window_minutes INTEGER NOT NULL,
      details JSONB,
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolution_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query("ALTER TABLE auth_security_alerts ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NOT NULL DEFAULT 'warning';");
  await pool.query("ALTER TABLE auth_security_alerts ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'open';");
  await pool.query('ALTER TABLE auth_security_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;');
  await pool.query('ALTER TABLE auth_security_alerts ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL;');
  await pool.query('ALTER TABLE auth_security_alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;');
  await pool.query('ALTER TABLE auth_security_alerts ADD COLUMN IF NOT EXISTS resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;');
  await pool.query('ALTER TABLE auth_security_alerts ADD COLUMN IF NOT EXISTS resolution_note TEXT;');
  await pool.query('CREATE INDEX IF NOT EXISTS auth_security_alerts_type_created_idx ON auth_security_alerts (alert_type, created_at DESC);');
  await pool.query('CREATE INDEX IF NOT EXISTS auth_security_alerts_subject_created_idx ON auth_security_alerts (subject_key, created_at DESC);');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_alert_delivery_logs (
      id SERIAL PRIMARY KEY,
      alert_id INTEGER NOT NULL REFERENCES auth_security_alerts(id) ON DELETE CASCADE,
      channel VARCHAR(30) NOT NULL,
      destination TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      success BOOLEAN NOT NULL DEFAULT false,
      response_status INTEGER,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS auth_alert_delivery_logs_alert_created_idx ON auth_alert_delivery_logs (alert_id, created_at DESC);');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) UNIQUE NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_reason VARCHAR(80),
      replaced_by_token_hash VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      user_agent TEXT,
      ip_address VARCHAR(120)
    );
  `);

  await pool.query('ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;');
  await pool.query('ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;');
  await pool.query('ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(80);');
  await pool.query('ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS replaced_by_token_hash VARCHAR(64);');
  await pool.query('ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();');
  await pool.query('ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;');
  await pool.query('ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;');
  await pool.query('ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS ip_address VARCHAR(120);');
  await pool.query('CREATE INDEX IF NOT EXISTS refresh_sessions_user_id_idx ON refresh_sessions (user_id);');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_reports (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vin VARCHAR(30) NOT NULL,
      make VARCHAR(100),
      model VARCHAR(100),
      year INTEGER,
      status VARCHAR(50),
      theft VARCHAR(150),
      ownership VARCHAR(150),
      accidents VARCHAR(150),
      mileage VARCHAR(150),
      score INTEGER,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      selected_for_comparison BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (user_id, vin)
    );
  `);

  await pool.query('ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS selected_for_comparison BOOLEAN NOT NULL DEFAULT false;');
  await pool.query('ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS photo TEXT;');


  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan VARCHAR(50) NOT NULL,
      amount INTEGER NOT NULL,
      phone VARCHAR(20) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      checkout_request_id VARCHAR(100) UNIQUE,
      mpesa_receipt VARCHAR(100),
      result_desc VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Stored in Postgres (not an in-memory Map) so pending codes survive a
  // redeploy or instance restart between /api/auth/otp/send and the follow-up
  // verification request.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      phone VARCHAR(20) PRIMARY KEY,
      code_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
  `);

  for (const vehicle of seedVehicles) {
    await pool.query(
      `
        INSERT INTO vehicles (vin, make, model, year, status, theft, ownership, accidents, mileage, score, source, photo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (vin) DO UPDATE SET
          make = EXCLUDED.make,
          model = EXCLUDED.model,
          year = EXCLUDED.year,
          status = EXCLUDED.status,
          theft = EXCLUDED.theft,
          ownership = EXCLUDED.ownership,
          accidents = EXCLUDED.accidents,
          mileage = EXCLUDED.mileage,
          score = EXCLUDED.score,
          source = EXCLUDED.source,
          photo = EXCLUDED.photo
      `,
      [vehicle.vin, vehicle.make, vehicle.model, vehicle.year, vehicle.status, vehicle.theft, vehicle.ownership, vehicle.accidents, vehicle.mileage, vehicle.score, vehicle.source, vehicle.photo || null]
    );
  }
};

app.get('/health', asyncHandler(async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'vinscope-vehicle-api', database: 'postgres' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}));

app.post('/api/client-errors', asyncHandler(async (req, res) => {
  const payload = req.body || {};
  const message = String(payload.message || '').trim();

  if (!message) {
    return sendApiError(req, res, 400, 'CLIENT_ERROR_MESSAGE_REQUIRED', 'Client error message is required');
  }

  await persistErrorEvent({
    source: 'client',
    category: String(payload.category || 'ui_error').trim(),
    severity: String(payload.severity || 'error').trim().toLowerCase(),
    message,
    code: payload.code || null,
    requestId: req.requestId || null,
    path: payload.path || req.get('referer') || null,
    method: 'CLIENT',
    userId: null,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
    stack: payload.stack || null,
    details: {
      componentStack: payload.componentStack || null,
      href: payload.href || null,
      extra: payload.extra || null,
    },
  });

  res.status(202).json({ ok: true });
}));

app.get('/api/admin/health/mpesa', requireAuth, (_req, res) => {
  const status = getMpesaConfigStatus();
  const callbackUrl = `${process.env.PUBLIC_BASE_URL || 'http://localhost:5000'}/api/payments/mpesa/callback`;

  res.json({
    ok: true,
    configured: status.configured,
    partiallyConfigured: status.partiallyConfigured,
    missing: status.missing,
    environment: status.environment,
    callbackUrl,
    mode: status.configured ? 'live' : 'demo-fallback',
  });
});

app.get('/api/admin/audit-logs', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    userId,
    email,
    eventType,
    from,
    to,
    limit,
    offset,
    format,
  } = req.query || {};

  const whereParts = [];
  const params = [];

  if (userId) {
    params.push(Number(userId));
    whereParts.push(`user_id = $${params.length}`);
  }

  if (email) {
    params.push(String(email).trim().toLowerCase());
    whereParts.push(`lower(email) = $${params.length}`);
  }

  if (eventType) {
    params.push(String(eventType).trim());
    whereParts.push(`event_type = $${params.length}`);
  }

  if (from) {
    const fromDate = new Date(String(from));
    if (Number.isNaN(fromDate.getTime())) {
      return sendApiError(req, res, 400, 'INVALID_FROM_DATE', 'Invalid from date');
    }
    params.push(fromDate.toISOString());
    whereParts.push(`created_at >= $${params.length}`);
  }

  if (to) {
    const toDate = new Date(String(to));
    if (Number.isNaN(toDate.getTime())) {
      return sendApiError(req, res, 400, 'INVALID_TO_DATE', 'Invalid to date');
    }
    params.push(toDate.toISOString());
    whereParts.push(`created_at <= $${params.length}`);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM auth_audit_logs ${whereClause}`,
    params
  );
  const total = Number(countResult.rows[0]?.total || 0);

  const queryParams = [...params, safeLimit, safeOffset];
  const { rows } = await pool.query(
    `
      SELECT
        id,
        event_type AS "eventType",
        user_id AS "userId",
        email,
        phone,
        success,
        failure_code AS "failureCode",
        request_id AS "requestId",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        details,
        created_at AS "createdAt"
      FROM auth_audit_logs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${queryParams.length - 1}
      OFFSET $${queryParams.length}
    `,
    queryParams
  );

  if (String(format || '').toLowerCase() === 'csv') {
    const header = ['id', 'eventType', 'userId', 'email', 'phone', 'success', 'failureCode', 'requestId', 'ipAddress', 'userAgent', 'details', 'createdAt'];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([
        row.id,
        row.eventType,
        row.userId,
        row.email,
        row.phone,
        row.success,
        row.failureCode,
        row.requestId,
        row.ipAddress,
        row.userAgent,
        row.details,
        row.createdAt,
      ].map(escapeCsvValue).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="auth-audit-logs.csv"');
    return res.send(lines.join('\n'));
  }

  res.json({
    logs: rows,
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      total,
      hasMore: safeOffset + rows.length < total,
      nextOffset: safeOffset + rows.length < total ? safeOffset + rows.length : null,
      previousOffset: safeOffset > 0 ? Math.max(safeOffset - safeLimit, 0) : null,
    },
    filters: { userId: userId || null, email: email || null, eventType: eventType || null, from: from || null, to: to || null, limit: safeLimit, offset: safeOffset },
  });
}));

app.get('/api/admin/security-alerts', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    alertType,
    severity,
    status,
    subject,
    from,
    to,
    limit,
    offset,
    format,
  } = req.query || {};

  const whereParts = [];
  const params = [];

  if (alertType) {
    params.push(String(alertType).trim());
    whereParts.push(`alert_type = $${params.length}`);
  }

  if (severity) {
    params.push(String(severity).trim().toLowerCase());
    whereParts.push(`lower(severity) = $${params.length}`);
  }

  if (status) {
    params.push(String(status).trim().toLowerCase());
    whereParts.push(`lower(status) = $${params.length}`);
  }

  if (subject) {
    params.push(String(subject).trim().toLowerCase());
    whereParts.push(`lower(subject_label) LIKE '%' || $${params.length} || '%'`);
  }

  if (from) {
    const fromDate = new Date(String(from));
    if (Number.isNaN(fromDate.getTime())) {
      return sendApiError(req, res, 400, 'INVALID_FROM_DATE', 'Invalid from date');
    }
    params.push(fromDate.toISOString());
    whereParts.push(`created_at >= $${params.length}`);
  }

  if (to) {
    const toDate = new Date(String(to));
    if (Number.isNaN(toDate.getTime())) {
      return sendApiError(req, res, 400, 'INVALID_TO_DATE', 'Invalid to date');
    }
    params.push(toDate.toISOString());
    whereParts.push(`created_at <= $${params.length}`);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM auth_security_alerts ${whereClause}`,
    params
  );
  const total = Number(countResult.rows[0]?.total || 0);

  const queryParams = [...params, safeLimit, safeOffset];
  const { rows } = await pool.query(
    `
      SELECT
        id,
        alert_type AS "alertType",
        severity,
        status,
        subject_key AS "subjectKey",
        subject_label AS "subjectLabel",
        event_count AS "eventCount",
        threshold,
        window_minutes AS "windowMinutes",
        details,
        acknowledged_at AS "acknowledgedAt",
        acknowledged_by AS "acknowledgedBy",
        resolved_at AS "resolvedAt",
        resolved_by AS "resolvedBy",
        resolution_note AS "resolutionNote",
        created_at AS "createdAt"
      FROM auth_security_alerts
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${queryParams.length - 1}
      OFFSET $${queryParams.length}
    `,
    queryParams
  );

  if (String(format || '').toLowerCase() === 'csv') {
    const header = ['id', 'alertType', 'severity', 'status', 'subjectKey', 'subjectLabel', 'eventCount', 'threshold', 'windowMinutes', 'details', 'acknowledgedAt', 'acknowledgedBy', 'resolvedAt', 'resolvedBy', 'resolutionNote', 'createdAt'];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([
        row.id,
        row.alertType,
        row.severity,
        row.status,
        row.subjectKey,
        row.subjectLabel,
        row.eventCount,
        row.threshold,
        row.windowMinutes,
        row.details,
        row.acknowledgedAt,
        row.acknowledgedBy,
        row.resolvedAt,
        row.resolvedBy,
        row.resolutionNote,
        row.createdAt,
      ].map(escapeCsvValue).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="auth-security-alerts.csv"');
    return res.send(lines.join('\n'));
  }

  res.json({
    alerts: rows,
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      total,
      hasMore: safeOffset + rows.length < total,
      nextOffset: safeOffset + rows.length < total ? safeOffset + rows.length : null,
      previousOffset: safeOffset > 0 ? Math.max(safeOffset - safeLimit, 0) : null,
    },
    filters: {
      alertType: alertType || null,
      severity: severity || null,
      status: status || null,
      subject: subject || null,
      from: from || null,
      to: to || null,
      limit: safeLimit,
      offset: safeOffset,
    },
  });
}));

app.get('/api/admin/alert-delivery-logs', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    alertId,
    channel,
    success,
    from,
    to,
    limit,
    offset,
  } = req.query || {};

  const whereParts = [];
  const params = [];

  if (alertId) {
    params.push(Number(alertId));
    whereParts.push(`alert_id = $${params.length}`);
  }

  if (channel) {
    params.push(String(channel).trim().toLowerCase());
    whereParts.push(`lower(channel) = $${params.length}`);
  }

  if (success === 'true' || success === 'false') {
    params.push(success === 'true');
    whereParts.push(`success = $${params.length}`);
  }

  if (from) {
    const fromDate = new Date(String(from));
    if (Number.isNaN(fromDate.getTime())) {
      return sendApiError(req, res, 400, 'INVALID_FROM_DATE', 'Invalid from date');
    }
    params.push(fromDate.toISOString());
    whereParts.push(`created_at >= $${params.length}`);
  }

  if (to) {
    const toDate = new Date(String(to));
    if (Number.isNaN(toDate.getTime())) {
      return sendApiError(req, res, 400, 'INVALID_TO_DATE', 'Invalid to date');
    }
    params.push(toDate.toISOString());
    whereParts.push(`created_at <= $${params.length}`);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM auth_alert_delivery_logs ${whereClause}`,
    params
  );
  const total = Number(countResult.rows[0]?.total || 0);

  const queryParams = [...params, safeLimit, safeOffset];
  const { rows } = await pool.query(
    `
      SELECT
        id,
        alert_id AS "alertId",
        channel,
        destination,
        attempt_number AS "attemptNumber",
        success,
        response_status AS "responseStatus",
        error_message AS "errorMessage",
        created_at AS "createdAt"
      FROM auth_alert_delivery_logs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${queryParams.length - 1}
      OFFSET $${queryParams.length}
    `,
    queryParams
  );

  res.json({
    logs: rows,
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      total,
      hasMore: safeOffset + rows.length < total,
      nextOffset: safeOffset + rows.length < total ? safeOffset + rows.length : null,
      previousOffset: safeOffset > 0 ? Math.max(safeOffset - safeLimit, 0) : null,
    },
    filters: {
      alertId: alertId || null,
      channel: channel || null,
      success: success ?? null,
      from: from || null,
      to: to || null,
      limit: safeLimit,
      offset: safeOffset,
    },
  });
}));

app.patch('/api/admin/security-alerts/bulk', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [];
  const action = String(req.body?.action || '').trim().toLowerCase();
  const note = String(req.body?.note || '').trim() || null;

  if (!ids.length) {
    return sendApiError(req, res, 400, 'ALERT_IDS_REQUIRED', 'At least one alert id is required');
  }

  if (!['acknowledge', 'resolve', 'reopen'].includes(action)) {
    return sendApiError(req, res, 400, 'INVALID_ALERT_ACTION', 'Action must be acknowledge, resolve, or reopen');
  }

  const query = action === 'acknowledge'
    ? `
        UPDATE auth_security_alerts
        SET
          status = CASE WHEN status = 'resolved' THEN status ELSE 'acknowledged' END,
          acknowledged_at = COALESCE(acknowledged_at, now()),
          acknowledged_by = COALESCE(acknowledged_by, $2)
        WHERE id = ANY($1::int[])
        RETURNING id, alert_type AS "alertType", severity, status, subject_key AS "subjectKey", subject_label AS "subjectLabel", event_count AS "eventCount", threshold, window_minutes AS "windowMinutes", details, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", created_at AS "createdAt"
      `
    : action === 'resolve'
      ? `
        UPDATE auth_security_alerts
        SET
          status = 'resolved',
          acknowledged_at = COALESCE(acknowledged_at, now()),
          acknowledged_by = COALESCE(acknowledged_by, $2),
          resolved_at = now(),
          resolved_by = $2,
          resolution_note = COALESCE($3, resolution_note)
        WHERE id = ANY($1::int[])
        RETURNING id, alert_type AS "alertType", severity, status, subject_key AS "subjectKey", subject_label AS "subjectLabel", event_count AS "eventCount", threshold, window_minutes AS "windowMinutes", details, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", created_at AS "createdAt"
      `
      : `
        UPDATE auth_security_alerts
        SET
          status = 'open',
          resolved_at = NULL,
          resolved_by = NULL,
          resolution_note = NULL
        WHERE id = ANY($1::int[])
        RETURNING id, alert_type AS "alertType", severity, status, subject_key AS "subjectKey", subject_label AS "subjectLabel", event_count AS "eventCount", threshold, window_minutes AS "windowMinutes", details, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", created_at AS "createdAt"
      `;

  const { rows } = await pool.query(
    query,
    action === 'acknowledge'
      ? [ids, req.user.id]
      : action === 'resolve'
        ? [ids, req.user.id, note]
        : [ids]
  );
  res.json({ alerts: rows, updatedCount: rows.length });
}));

app.patch('/api/admin/security-alerts/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const alertId = Number(req.params.id);
  const action = String(req.body?.action || '').trim().toLowerCase();
  const note = String(req.body?.note || '').trim() || null;

  if (!Number.isFinite(alertId)) {
    return sendApiError(req, res, 400, 'INVALID_ALERT_ID', 'Invalid alert id');
  }

  if (!['acknowledge', 'resolve', 'reopen'].includes(action)) {
    return sendApiError(req, res, 400, 'INVALID_ALERT_ACTION', 'Action must be acknowledge, resolve, or reopen');
  }

  const query = action === 'acknowledge'
    ? `
        UPDATE auth_security_alerts
        SET
          status = CASE WHEN status = 'resolved' THEN status ELSE 'acknowledged' END,
          acknowledged_at = COALESCE(acknowledged_at, now()),
          acknowledged_by = COALESCE(acknowledged_by, $2)
        WHERE id = $1
        RETURNING id, alert_type AS "alertType", severity, status, subject_key AS "subjectKey", subject_label AS "subjectLabel", event_count AS "eventCount", threshold, window_minutes AS "windowMinutes", details, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", created_at AS "createdAt"
      `
    : action === 'resolve'
      ? `
        UPDATE auth_security_alerts
        SET
          status = 'resolved',
          acknowledged_at = COALESCE(acknowledged_at, now()),
          acknowledged_by = COALESCE(acknowledged_by, $2),
          resolved_at = now(),
          resolved_by = $2,
          resolution_note = COALESCE($3, resolution_note)
        WHERE id = $1
        RETURNING id, alert_type AS "alertType", severity, status, subject_key AS "subjectKey", subject_label AS "subjectLabel", event_count AS "eventCount", threshold, window_minutes AS "windowMinutes", details, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", created_at AS "createdAt"
      `
      : `
        UPDATE auth_security_alerts
        SET
          status = 'open',
          resolved_at = NULL,
          resolved_by = NULL,
          resolution_note = NULL
        WHERE id = $1
        RETURNING id, alert_type AS "alertType", severity, status, subject_key AS "subjectKey", subject_label AS "subjectLabel", event_count AS "eventCount", threshold, window_minutes AS "windowMinutes", details, acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy", resolution_note AS "resolutionNote", created_at AS "createdAt"
      `;

  const { rows } = await pool.query(
    query,
    action === 'acknowledge'
      ? [alertId, req.user.id]
      : action === 'resolve'
        ? [alertId, req.user.id, note]
        : [alertId]
  );
  if (!rows[0]) {
    return sendApiError(req, res, 404, 'SECURITY_ALERT_NOT_FOUND', 'Security alert not found');
  }

  res.json({ alert: rows[0] });
}));

const VEHICLE_COLUMNS = `
  vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
  manufacturer, plant_country AS "plantCountry", body_class AS "bodyClass",
  vehicle_type AS "vehicleType", fuel_type AS "fuelType", engine_cylinders AS "engineCylinders",
  displacement_l AS "displacementL", history_available AS "historyAvailable", photo
`;

const parseCountFromText = (value) => {
  const text = String(value || '');
  const match = text.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
};

const isMileageInconsistent = (value) => {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  if (/no public odometer record|unavailable|unknown/.test(text)) return true;
  if (/consistent/.test(text) && !/rollback|decreased|gap|jump|unchanged|varies|suspected|inconsistent/.test(text)) {
    return false;
  }
  return /rollback|decreased|gap|jump|unchanged|varies|suspected|inconsistent|flatline|sharply/.test(text);
};

function calculateVehicleScore(record = {}) {
  if (record.historyAvailable === false) {
    return null;
  }

  const theftText = String(record.theft || '').toLowerCase();
  const accidentsText = String(record.accidents || '').toLowerCase();
  const mileageText = String(record.mileage || '').toLowerCase();
  const ownershipText = String(record.ownership || '').toLowerCase();

  let theftPenalty = 0;
  if (theftText && !/no record|no theft|none|clear/.test(theftText)) {
    const theftCount = Math.max(parseCountFromText(theftText), 1);
    theftPenalty = 30 + Math.min((theftCount - 1) * 8, 24);
  }

  let accidentPenalty = 0;
  if (accidentsText && !/no major accidents|0 reported incidents|no record|none/.test(accidentsText)) {
    const accidentCount = parseCountFromText(accidentsText);
    accidentPenalty = Math.min(accidentCount * 7, 28);
    if (/major|severe|structural/.test(accidentsText)) {
      accidentPenalty += 6;
    }
  }

  let mileagePenalty = 0;
  if (isMileageInconsistent(mileageText)) {
    if (/rollback|decreased/.test(mileageText)) {
      mileagePenalty = 30;
    } else if (/unchanged|flatline/.test(mileageText)) {
      mileagePenalty = 22;
    } else if (/gap|jump|varies|suspected|inconsistent|sharply/.test(mileageText)) {
      mileagePenalty = 18;
    } else {
      mileagePenalty = 10;
    }
  }

  const ownerCount = /new import|not yet registered|unregistered/.test(ownershipText)
    ? 0
    : parseCountFromText(ownershipText) || (/single|one owner/.test(ownershipText) ? 1 : 0);
  const previousOwnerCount = Math.max(ownerCount - 1, 0);
  const ownershipPenalty = Math.min(previousOwnerCount * 4, 20);

  const totalPenalty = theftPenalty + accidentPenalty + mileagePenalty + ownershipPenalty;
  return Math.max(0, Math.min(100, Math.round(100 - totalPenalty)));
}

const withDerivedScore = (record = {}) => ({
  ...record,
  score: calculateVehicleScore(record),
});

async function upsertVehicle(vehicle) {
  const {
    vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
    manufacturer = null, plantCountry = null, bodyClass = null, vehicleType = null,
    fuelType = null, engineCylinders = null, displacementL = null, historyAvailable = true,
    photo = null,
  } = vehicle;

  const calculatedScore = calculateVehicleScore({ theft, ownership, accidents, mileage, historyAvailable });

  const { rows } = await pool.query(
    `
      INSERT INTO vehicles (
        vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
        manufacturer, plant_country, body_class, vehicle_type, fuel_type, engine_cylinders, displacement_l, history_available, photo
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (vin) DO UPDATE SET
        make = EXCLUDED.make,
        model = EXCLUDED.model,
        year = EXCLUDED.year,
        status = EXCLUDED.status,
        theft = EXCLUDED.theft,
        ownership = EXCLUDED.ownership,
        accidents = EXCLUDED.accidents,
        mileage = EXCLUDED.mileage,
        score = EXCLUDED.score,
        source = EXCLUDED.source,
        manufacturer = EXCLUDED.manufacturer,
        plant_country = EXCLUDED.plant_country,
        body_class = EXCLUDED.body_class,
        vehicle_type = EXCLUDED.vehicle_type,
        fuel_type = EXCLUDED.fuel_type,
        engine_cylinders = EXCLUDED.engine_cylinders,
        displacement_l = EXCLUDED.displacement_l,
        history_available = EXCLUDED.history_available,
        photo = EXCLUDED.photo
      RETURNING ${VEHICLE_COLUMNS}
    `,
    [
      vin, make, model, year, status, theft, ownership, accidents, mileage, calculatedScore, source,
      manufacturer, plantCountry, bodyClass, vehicleType, fuelType, engineCylinders, displacementL, historyAvailable,
      photo,
    ]
  );

  return withDerivedScore(rows[0]);
}

app.get('/api/vehicles/:vin', asyncHandler(async (req, res) => {
  const vin = req.params.vin.trim().toUpperCase();

  if (!isValidVinFormat(vin)) {
    return sendApiError(
      req,
      res,
      400,
      'INVALID_VIN_FORMAT',
      `Invalid VIN format. A VIN is 17 characters (letters and numbers, excluding I, O, Q). You entered ${vin.length} character${vin.length === 1 ? '' : 's'}.`,
      { vin }
    );
  }

  const { rows } = await pool.query(`SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE vin = $1`, [vin]);

  if (rows[0]) {
    return res.json(withDerivedScore(rows[0]));
  }

  // Not in our database - fall back to the free, public NHTSA vPIC decoder for a real VIN decode.
  // This works for VINs from any country (Kenya, Japan, etc.) since VIN structure is a global
  // ISO 3779 standard, but it cannot provide accident/theft/ownership history (no such free
  // public source exists), which is reflected via historyAvailable: false.
  const decoded = await decodeVinWithNhtsa(vin);
  if (!decoded) {
    return sendApiError(req, res, 404, 'VEHICLE_NOT_FOUND', 'Vehicle not found', { vin });
  }

  const mapped = mapNhtsaResultToVehicle(vin, decoded);
  const cached = await upsertVehicle(mapped);
  return res.json(cached);
}));

// Requires an authenticated user so only logged-in users can create/overwrite vehicle records.
app.post('/api/vehicles', requireAuth, asyncHandler(async (req, res) => {
  const vehicle = req.body;
  if (!vehicle?.vin) {
    return sendApiError(req, res, 400, 'VIN_REQUIRED', 'VIN is required');
  }

  const saved = await upsertVehicle({
    ...vehicle,
    vin: vehicle.vin.toUpperCase(),
    source: vehicle.source || 'postgres',
  });

  return res.status(201).json(saved);
}));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Sends a 6-digit SMS code to a phone number, for either 'register' (new signup)
// or 'login' (existing account) purposes. In demo mode (no SMS provider configured)
// the code is echoed back in the response outside of production so the flow can
// still be tested end to end.
app.post('/api/auth/otp/send', otpLimiter, asyncHandler(async (req, res) => {
  const { phone, purpose } = req.body || {};
  const normalizedPhone = normalizeKenyanPhone(phone);

  if (normalizedPhone) {
    const phoneLock = await ensureAbuseNotLocked(req, res, 'OTP_SEND_PHONE', normalizedPhone, 'OTP_SEND_PHONE_LIMIT', 'Too many code requests for this phone number. Please try again later.');
    if (phoneLock) return phoneLock;
  }

  const ipLock = await ensureAbuseNotLocked(req, res, 'OTP_SEND_IP', req.ip || 'unknown', 'OTP_SEND_IP_LIMIT', 'Too many code requests from this network. Please try again later.');
  if (ipLock) return ipLock;

  const ipQuota = await registerAbuseAttempt('OTP_SEND_IP', req.ip || 'unknown', {
    threshold: OTP_SEND_MAX_PER_IP,
    windowMinutes: OTP_SEND_WINDOW_MINUTES,
    lockoutMinutes: OTP_SEND_LOCKOUT_MINUTES,
  });
  if (ipQuota.blocked) {
    return sendApiError(req, res, 429, 'OTP_SEND_IP_LIMIT', 'Too many code requests from this network. Please try again later.', { lockedUntil: ipQuota.lockedUntil });
  }

  if (normalizedPhone) {
    const phoneQuota = await registerAbuseAttempt('OTP_SEND_PHONE', normalizedPhone, {
      threshold: OTP_SEND_MAX_PER_PHONE,
      windowMinutes: OTP_SEND_WINDOW_MINUTES,
      lockoutMinutes: OTP_SEND_LOCKOUT_MINUTES,
    });
    if (phoneQuota.blocked) {
      return sendApiError(req, res, 429, 'OTP_SEND_PHONE_LIMIT', 'Too many code requests for this phone number. Please try again later.', { lockedUntil: phoneQuota.lockedUntil });
    }
  }

  const issued = await issueOtp(pool, phone);
  if (!issued) {
    return sendApiError(req, res, 400, 'INVALID_PHONE', 'Enter a valid Kenyan phone number (e.g. 0712345678).');
  }

  try {
    if (purpose === 'login') {
      const { rows } = await pool.query('SELECT id FROM users WHERE phone = $1', [issued.normalized]);
      if (!rows.length) {
        return sendApiError(req, res, 404, 'PHONE_ACCOUNT_NOT_FOUND', 'No account found with that phone number.');
      }
    } else {
      const { rows } = await pool.query('SELECT id FROM users WHERE phone = $1', [issued.normalized]);
      if (rows.length) {
        return sendApiError(req, res, 409, 'PHONE_ALREADY_REGISTERED', 'An account with that phone number already exists.');
      }
    }
  } catch (error) {
    console.error('OTP lookup failed', error);
    return sendApiError(req, res, 500, 'OTP_LOOKUP_FAILED', 'Something went wrong. Please try again.');
  }

  const demoModeAllowed = process.env.NODE_ENV !== 'production' || process.env.OTP_DEMO_MODE === 'true';
  try {
    await sendSms(issued.normalized, `Your Vinscope Kenya verification code is ${issued.code}. It expires in 5 minutes.`);
  } catch (error) {
    console.error('SMS send failed', error);
    if (!demoModeAllowed) {
      return sendApiError(req, res, 502, 'SMS_SEND_FAILED', 'Could not send the SMS right now. Please try again.');
    }
    // Provider is configured but failing (e.g. bad credentials) - fall through to the demo code below.
  }

  const response = { success: true, expiresInSeconds: 300 };
  // Africa's Talking can report a synchronous "Success" that only means the message was
  // queued, not that it actually reached the handset - real delivery failures happen
  // asynchronously and aren't visible here. So whenever demo mode is allowed, always
  // include the code as a guaranteed fallback rather than trusting the SMS "succeeded".
  if (demoModeAllowed) {
    response.demoCode = issued.code;
  }

  return res.json(response);
}));

// Verifies a phone + code pair and logs the matching account in - passwordless login via SMS.
app.post('/api/auth/otp/login', loginLimiter, asyncHandler(async (req, res) => {
  const { phone, code } = req.body || {};
  const normalizedPhone = normalizeKenyanPhone(phone);

  if (normalizedPhone) {
    const phoneLock = await ensureAbuseNotLocked(req, res, 'OTP_VERIFY_PHONE', normalizedPhone, 'OTP_VERIFY_PHONE_LIMIT', 'Too many OTP attempts for this phone number. Please try again later.');
    if (phoneLock) return phoneLock;
  }
  const ipLock = await ensureAbuseNotLocked(req, res, 'OTP_VERIFY_IP', req.ip || 'unknown', 'OTP_VERIFY_IP_LIMIT', 'Too many OTP attempts from this network. Please try again later.');
  if (ipLock) return ipLock;

  const result = await verifyOtp(pool, phone, code);
  if (!result.success) {
    if (normalizedPhone) {
      const phoneFailure = await registerAbuseAttempt('OTP_VERIFY_PHONE', normalizedPhone, {
        threshold: OTP_VERIFY_MAX_FAILURES_PER_PHONE,
        windowMinutes: OTP_VERIFY_WINDOW_MINUTES,
        lockoutMinutes: OTP_VERIFY_LOCKOUT_MINUTES,
      });
      if (phoneFailure.blocked) {
        return sendApiError(req, res, 429, 'OTP_VERIFY_PHONE_LIMIT', 'Too many OTP attempts for this phone number. Please try again later.', { lockedUntil: phoneFailure.lockedUntil });
      }
    }

    const ipFailure = await registerAbuseAttempt('OTP_VERIFY_IP', req.ip || 'unknown', {
      threshold: OTP_VERIFY_MAX_FAILURES_PER_IP,
      windowMinutes: OTP_VERIFY_WINDOW_MINUTES,
      lockoutMinutes: OTP_VERIFY_LOCKOUT_MINUTES,
    });
    if (ipFailure.blocked) {
      return sendApiError(req, res, 429, 'OTP_VERIFY_IP_LIMIT', 'Too many OTP attempts from this network. Please try again later.', { lockedUntil: ipFailure.lockedUntil });
    }

    return sendApiError(req, res, 400, 'OTP_VERIFICATION_FAILED', result.message);
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, is_verified, verification_method, is_admin, session_version FROM users WHERE phone = $1',
      [result.normalized]
    );
    const user = rows[0];
    if (!user) {
      await recordAuthAudit(req, {
        eventType: 'AUTH_OTP_LOGIN_FAILED',
        phone: result.normalized,
        success: false,
        failureCode: 'PHONE_ACCOUNT_NOT_FOUND',
      });
      return sendApiError(req, res, 404, 'PHONE_ACCOUNT_NOT_FOUND', 'No account found with that phone number.');
    }

    await clearFailedLoginState(user.id);
  await clearAbuseBucket('OTP_VERIFY_IP', req.ip || 'unknown');
  await clearAbuseBucket('OTP_VERIFY_PHONE', result.normalized);
    await issueAuthSession(req, res, user);
    await recordAuthAudit(req, {
      eventType: 'AUTH_OTP_LOGIN_SUCCEEDED',
      userId: user.id,
      email: user.email,
      phone: result.normalized,
      success: true,
    });
    return res.json({ user: serializeUser(user) });
  } catch (error) {
    console.error('Phone login failed', error);
    return sendApiError(req, res, 500, 'PHONE_LOGIN_FAILED', 'Login failed. Please try again.');
  }
}));

app.post('/api/auth/register', registerLimiter, asyncHandler(async (req, res) => {
  const { email, password, name, phone, code, verificationMethod, acceptedTerms, acceptedPrivacy } = req.body || {};

  if (!email || !password) {
    return sendApiError(req, res, 400, 'EMAIL_PASSWORD_REQUIRED', 'Email and password are required');
  }
  if (!EMAIL_REGEX.test(email)) {
    return sendApiError(req, res, 400, 'INVALID_EMAIL', 'Enter a valid email address');
  }
  if (String(password).length < 6) {
    return sendApiError(req, res, 400, 'PASSWORD_TOO_SHORT', 'Password must be at least 6 characters');
  }
  if (!acceptedTerms || !acceptedPrivacy) {
    return sendApiError(req, res, 400, 'LEGAL_CONSENT_REQUIRED', 'You must accept the Terms and Privacy Policy to create an account.');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const usingSms = verificationMethod === 'sms';
  let normalizedPhone = null;

  if (usingSms) {
    if (!phone || !code) {
      return sendApiError(req, res, 400, 'SMS_CODE_REQUIRED', 'Enter the SMS code sent to your phone.');
    }

    const otpResult = await verifyOtp(pool, phone, code);
    if (!otpResult.success) {
      return sendApiError(req, res, 400, 'OTP_VERIFICATION_FAILED', otpResult.message);
    }

    normalizedPhone = otpResult.normalized;
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length) {
      return sendApiError(req, res, 409, 'EMAIL_ALREADY_REGISTERED', 'An account with that email already exists');
    }

    if (normalizedPhone) {
      const existingPhone = await pool.query('SELECT id FROM users WHERE phone = $1', [normalizedPhone]);
      if (existingPhone.rows.length) {
        return sendApiError(req, res, 409, 'PHONE_ALREADY_REGISTERED', 'An account with that phone number already exists');
      }
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name, phone, is_verified, verification_method, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id, email, name, phone, is_verified, verification_method, is_admin, session_version',
      [normalizedEmail, passwordHash, (name || '').trim() || 'Vinscope User', normalizedPhone, true, usingSms ? 'sms' : 'email']
    );

    const user = rows[0];
    await recordUserConsent({
      userId: user.id,
      policyVersion: LEGAL_POLICY_VERSION,
      acceptedTerms: true,
      acceptedPrivacy: true,
      source: 'register',
      req,
    });
    await issueAuthSession(req, res, user);
    await recordAuthAudit(req, {
      eventType: 'AUTH_REGISTER_SUCCEEDED',
      userId: user.id,
      email: user.email,
      phone: user.phone || null,
      success: true,
    });
    return res.status(201).json({ user: serializeUser(user) });
  } catch (error) {
    console.error('Registration failed', error);
    return sendApiError(req, res, 500, 'REGISTRATION_FAILED', 'Registration failed. Please try again.');
  }
}));

app.post('/api/auth/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const loginIp = req.ip || 'unknown';

  const ipLock = await ensureAbuseNotLocked(req, res, 'LOGIN_IP', loginIp, 'LOGIN_IP_BACKOFF', 'Too many failed login attempts from this network. Please try again later.');
  if (ipLock) return ipLock;

  if (!email || !password) {
    return sendApiError(req, res, 400, 'EMAIL_PASSWORD_REQUIRED', 'Email and password are required');
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash, is_verified, verification_method, is_admin, failed_login_attempts, locked_until, session_version FROM users WHERE email = $1',
      [normalizedEmail]
    );
    const user = rows[0];

    if (user && isFutureDate(user.locked_until)) {
      await recordAuthAudit(req, {
        eventType: 'AUTH_ACCOUNT_LOCKED',
        userId: user.id,
        email: user.email,
        success: false,
        failureCode: 'ACCOUNT_LOCKED',
        details: { lockedUntil: user.locked_until },
      });
      return sendApiError(req, res, 423, 'ACCOUNT_LOCKED', 'Too many failed login attempts. Please try again later.', {
        lockedUntil: user.locked_until,
      });
    }

    const valid = user && (await verifyPassword(password, user.password_hash));

    if (!valid) {
      if (user) {
        const failedState = await recordFailedLoginAttempt(user.id);
        if (failedState && isFutureDate(failedState.locked_until)) {
          await recordAuthAudit(req, {
            eventType: 'AUTH_ACCOUNT_LOCKED',
            userId: user.id,
            email: user.email,
            success: false,
            failureCode: 'ACCOUNT_LOCKED',
            details: { lockedUntil: failedState.locked_until },
          });
          return sendApiError(req, res, 423, 'ACCOUNT_LOCKED', 'Too many failed login attempts. Please try again later.', {
            lockedUntil: failedState.locked_until,
          });
        }
      }

      const ipFailure = await registerAbuseAttempt('LOGIN_IP', loginIp, {
        threshold: LOGIN_IP_MAX_FAILURES,
        windowMinutes: LOGIN_IP_WINDOW_MINUTES,
        lockoutMinutes: LOGIN_IP_LOCKOUT_MINUTES,
      });
      if (ipFailure.blocked) {
        return sendApiError(req, res, 429, 'LOGIN_IP_BACKOFF', 'Too many failed login attempts from this network. Please try again later.', { lockedUntil: ipFailure.lockedUntil });
      }

      await recordAuthAudit(req, {
        eventType: 'AUTH_LOGIN_FAILED',
        userId: user?.id || null,
        email: normalizedEmail,
        success: false,
        failureCode: 'INVALID_CREDENTIALS',
      });
      return sendApiError(req, res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    await clearFailedLoginState(user.id);
    await clearAbuseBucket('LOGIN_IP', loginIp);
    await issueAuthSession(req, res, user);
    await recordAuthAudit(req, {
      eventType: 'AUTH_LOGIN_SUCCEEDED',
      userId: user.id,
      email: user.email,
      success: true,
    });
    return res.json({ user: serializeUser(user) });
  } catch (error) {
    console.error('Login failed', error);
    return sendApiError(req, res, 500, 'LOGIN_FAILED', 'Login failed. Please try again.');
  }
}));

app.post('/api/auth/logout', requireAuth, asyncHandler(async (req, res) => {
  await revokeRefreshSessionByToken(req.cookies?.[REFRESH_COOKIE_NAME], 'manual_logout');
  clearAuthCookies(res);
  await recordAuthAudit(req, {
    eventType: 'AUTH_LOGOUT_SUCCEEDED',
    userId: req.user.id,
    email: req.user.email || null,
    success: true,
  });
  res.json({ ok: true });
}));

app.post('/api/auth/logout-all', requireAuth, asyncHandler(async (req, res) => {
  await revokeUserSessions(req.user.id);
  await revokeAllRefreshSessionsForUser(req.user.id);
  clearAuthCookies(res);
  await recordAuthAudit(req, {
    eventType: 'AUTH_LOGOUT_ALL_SUCCEEDED',
    userId: req.user.id,
    email: req.user.email || null,
    success: true,
  });
  res.json({ ok: true });
}));

app.post('/api/auth/refresh', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!refreshToken) {
    clearAuthCookies(res);
    await recordAuthAudit(req, {
      eventType: 'AUTH_REFRESH_FAILED',
      success: false,
      failureCode: 'REFRESH_TOKEN_REQUIRED',
    });
    return sendApiError(req, res, 401, 'REFRESH_TOKEN_REQUIRED', 'Refresh token is required.');
  }

  const result = await rotateRefreshSession(req, res, refreshToken);
  if (!result.ok) {
    clearAuthCookies(res);
    await recordAuthAudit(req, {
      eventType: result.code === 'REFRESH_TOKEN_REUSED' ? 'AUTH_REFRESH_REUSED' : 'AUTH_REFRESH_FAILED',
      userId: result.userId || null,
      success: false,
      failureCode: result.code,
    });
    return sendApiError(req, res, 401, result.code, result.message);
  }

  await recordAuthAudit(req, {
    eventType: 'AUTH_REFRESH_SUCCEEDED',
    userId: result.user.id,
    email: result.user.email,
    success: true,
  });
  return res.json({ user: result.user });
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, is_verified, verification_method, is_admin FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) {
    return sendApiError(req, res, 404, 'USER_NOT_FOUND', 'User not found');
  }
  res.json({ user: serializeUser(rows[0]) });
}));

app.get('/api/auth/data-export', requireAuth, asyncHandler(async (req, res) => {
  const bundle = await exportUserDataBundle(req.user.id);
  res.json(bundle);
}));

app.post('/api/auth/data-deletion-request', requireAuth, asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || '').trim() || null;
  const queued = await queueDeletionRequest({
    userId: req.user.id,
    email: req.user.email || null,
    reason,
    req,
  });

  await revokeUserSessions(req.user.id);
  await revokeAllRefreshSessionsForUser(req.user.id);
  clearAuthCookies(res);

  await recordAuthAudit(req, {
    eventType: 'AUTH_DATA_DELETION_REQUESTED',
    userId: req.user.id,
    email: req.user.email || null,
    success: true,
    details: { requestId: queued?.id || null },
  });

  res.status(202).json({
    ok: true,
    request: queued,
    message: 'Your data deletion request has been received and queued for compliance processing.',
  });
}));

app.get('/api/auth/sessions', requireAuth, asyncHandler(async (req, res) => {
  const payload = await getUserSessions(req.user.id, req.cookies?.[REFRESH_COOKIE_NAME], req.query || {});
  res.json(payload);
}));

app.get('/api/admin/sessions', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const payload = await getAdminSessions(req.query || {});
  res.json(payload);
}));

// ---------------------------------------------------------------------------
// Saved reports (per authenticated user)
// ---------------------------------------------------------------------------

const REPORT_COLUMNS = `vin, make, model, year, status, theft, ownership, accidents, mileage, score, photo, saved_at AS "savedAt", selected_for_comparison AS "selectedForComparison"`;

app.get('/api/reports', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${REPORT_COLUMNS} FROM saved_reports WHERE user_id = $1 ORDER BY saved_at DESC`,
    [req.user.id]
  );
  res.json(rows.map((row) => withDerivedScore(row)));
}));

app.post('/api/reports', requireAuth, asyncHandler(async (req, res) => {
  const report = req.body || {};
  if (!report.vin) {
    return sendApiError(req, res, 400, 'VIN_REQUIRED', 'VIN is required');
  }

  const calculatedScore = calculateVehicleScore({
    theft: report.theft,
    ownership: report.ownership,
    accidents: report.accidents,
    mileage: report.mileage,
    historyAvailable: true,
  });

  const { rows } = await pool.query(
    `
      INSERT INTO saved_reports (user_id, vin, make, model, year, status, theft, ownership, accidents, mileage, score, photo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (user_id, vin) DO UPDATE SET
        make = EXCLUDED.make, model = EXCLUDED.model, year = EXCLUDED.year, status = EXCLUDED.status,
        theft = EXCLUDED.theft, ownership = EXCLUDED.ownership, accidents = EXCLUDED.accidents,
        mileage = EXCLUDED.mileage, score = EXCLUDED.score, photo = EXCLUDED.photo, saved_at = now()
      RETURNING ${REPORT_COLUMNS}
    `,
    [
      req.user.id,
      String(report.vin).toUpperCase(),
      report.make || null,
      report.model || null,
      report.year || null,
      report.status || null,
      report.theft || null,
      report.ownership || null,
      report.accidents || null,
      report.mileage || null,
      calculatedScore,
      report.photo || null,
    ]
  );

  res.status(201).json(withDerivedScore(rows[0]));
}));

app.delete('/api/reports/:vin', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM saved_reports WHERE user_id = $1 AND vin = $2', [
    req.user.id,
    req.params.vin.toUpperCase(),
  ]);
  res.json({ ok: true });
}));

app.patch('/api/reports/:vin/comparison', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE saved_reports SET selected_for_comparison = $1 WHERE user_id = $2 AND vin = $3 RETURNING ${REPORT_COLUMNS}`,
    [Boolean(req.body?.selected), req.user.id, req.params.vin.toUpperCase()]
  );

  if (!rows[0]) {
    return sendApiError(req, res, 404, 'SAVED_REPORT_NOT_FOUND', 'Saved report not found');
  }

  res.json(withDerivedScore(rows[0]));
}));

// ---------------------------------------------------------------------------
// M-Pesa payments (Daraja STK Push)
// ---------------------------------------------------------------------------

const PLAN_AMOUNTS = { Starter: 0, Pro: 1500, Business: 2999 };

app.post('/api/payments/stkpush', requireAuth, asyncHandler(async (req, res) => {
  const { plan, phone } = req.body || {};
  const amount = PLAN_AMOUNTS[plan];

  if (!amount) {
    return sendApiError(req, res, 400, 'INVALID_PLAN', 'Choose a valid plan (Pro or Business)');
  }

  const normalizedPhone = normalizeKenyanPhone(phone);
  if (!normalizedPhone) {
    return sendApiError(req, res, 400, 'INVALID_MPESA_PHONE', 'Enter a valid Safaricom number, e.g. 07XXXXXXXX');
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const stk = await initiateStkPush({
      phone: normalizedPhone,
      amount,
      plan,
      callbackUrl: `${publicBaseUrl}/api/payments/mpesa/callback`,
    });

    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, amount, phone, status, checkout_request_id)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (checkout_request_id) DO NOTHING`,
      [req.user.id, plan, amount, normalizedPhone, stk.CheckoutRequestID]
    );

    return res.status(202).json({
      checkoutRequestId: stk.CheckoutRequestID,
      message: stk.CustomerMessage || 'Enter your M-Pesa PIN on your phone to complete payment.',
    });
  } catch (error) {
    const diagnostics = error.mpesaDiagnostics || null;
    console.error('STK push failed', diagnostics || error);
    return sendApiError(
      req,
      res,
      502,
      'MPESA_STK_PUSH_FAILED',
      error.message || 'Could not start M-Pesa payment',
      {
        diagnostics,
        hint: 'Verify Daraja credentials, shortcode/passkey, callback URL, and Safaricom number format.',
      }
    );
  }
}));

// Public endpoint - called by Safaricom's servers, not the browser.
app.post('/api/payments/mpesa/callback', asyncHandler(async (req, res) => {
  const result = parseStkCallback(req.body);

  if (result) {
    await pool.query(
      `UPDATE subscriptions
       SET status = $1, mpesa_receipt = $2, result_desc = $3, updated_at = now()
       WHERE checkout_request_id = $4`,
      [result.success ? 'completed' : 'failed', result.mpesaReceipt, result.resultDesc, result.checkoutRequestId]
    );
  }

  // Safaricom expects a 200 response acknowledging receipt of the callback.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

app.get('/api/payments/status/:checkoutRequestId', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT status, plan, mpesa_receipt AS "mpesaReceipt" FROM subscriptions WHERE checkout_request_id = $1 AND user_id = $2',
    [req.params.checkoutRequestId, req.user.id]
  );

  if (!rows[0]) {
    return sendApiError(req, res, 404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  }

  res.json(rows[0]);
}));

app.use('/api', (req, res) => {
  sendApiError(req, res, 404, 'API_ROUTE_NOT_FOUND', 'API route not found', {
    method: req.method,
    path: req.originalUrl,
  });
});

app.get(/^(?!\/api|\/health).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = Number(error?.status) || 500;
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_SERVER_ERROR';
  const message = status >= 500 ? 'Internal server error' : (error?.message || 'Request failed');

  console.error(`[${req.requestId || 'no-request-id'}] Unhandled request error`, error);
  persistErrorEvent({
    source: 'server',
    category: 'request_error',
    severity: status >= 500 ? 'error' : 'warning',
    message: error?.message || 'Unhandled request error',
    code,
    requestId: req.requestId || null,
    path: req.originalUrl || req.path || null,
    method: req.method || null,
    userId: req.user?.id || null,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
    stack: error?.stack || null,
    details: { status },
  });
  return sendApiError(req, res, status, code, message);
});

const logProcessFatal = (type, error) => {
  console.error(`[process-fatal:${type}]`, error);
  persistErrorEvent({
    source: 'server',
    category: type,
    severity: 'critical',
    message: error?.message || String(error),
    code: type,
    stack: error?.stack || null,
    details: { reason: typeof error === 'object' ? undefined : String(error) },
  });
};

process.on('uncaughtException', (error) => {
  logProcessFatal('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  logProcessFatal('unhandledRejection', reason);
});

const port = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'test') {
  initializeDatabase()
    .then(() => {
      app.listen(port, () => {
        console.log(`Vehicle API listening on port ${port}`);
      });
    })
    .catch((error) => {
      console.error('Database initialization failed', error);
      process.exit(1);
    });
}

export { app, pool, initializeDatabase };
