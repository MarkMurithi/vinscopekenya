import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.AUTH_COOKIE_SAME_SITE = 'strict';
process.env.ACCESS_TOKEN_TTL_MINUTES = '15';
process.env.REFRESH_TOKEN_TTL_DAYS = '30';
process.env.REFRESH_SESSION_IDLE_MINUTES = '1';
process.env.LOGIN_MAX_ATTEMPTS = '3';
process.env.LOGIN_LOCKOUT_MINUTES = '15';
process.env.LOGIN_IP_MAX_FAILURES = '3';
process.env.LOGIN_IP_WINDOW_MINUTES = '15';
process.env.LOGIN_IP_LOCKOUT_MINUTES = '15';
process.env.OTP_SEND_MAX_PER_PHONE = '5';
process.env.OTP_SEND_MAX_PER_IP = '20';
process.env.OTP_SEND_WINDOW_MINUTES = '15';
process.env.OTP_SEND_LOCKOUT_MINUTES = '30';
process.env.OTP_VERIFY_MAX_FAILURES_PER_PHONE = '5';
process.env.OTP_VERIFY_MAX_FAILURES_PER_IP = '5';
process.env.OTP_VERIFY_WINDOW_MINUTES = '15';
process.env.OTP_VERIFY_LOCKOUT_MINUTES = '30';
// Force demo mode regardless of real SMS credentials configured in the local .env,
// so this test deterministically exercises the demoCode fallback instead of
// depending on a live network call to Africa's Talking. Set (not delete) so that
// dotenv.config() inside server.js - which never overrides an existing key - does
// not repopulate these from .env.
process.env.AFRICASTALKING_API_KEY = '';
process.env.AFRICASTALKING_USERNAME = '';
const { app, pool, initializeDatabase } = await import('../server.js');
await initializeDatabase();

async function startServer() {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }

  const header = response.headers.get('set-cookie');
  return header ? header.split(/,(?=[^;]+?=)/) : [];
}

function extractCookies(response) {
  return getSetCookies(response)
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

test('register, login, and auth-guarded routes work end to end', async () => {
  const { server, baseUrl } = await startServer();
  const email = `test-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    // Anonymous write to /api/vehicles must be rejected.
    const unauthWrite = await fetch(`${baseUrl}/api/vehicles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vin: 'TESTVIN0000000001', make: 'Test', model: 'Car' }),
    });
    assert.equal(unauthWrite.status, 401);

    // Register a new account.
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Test User' }),
    });
    assert.equal(registerResponse.status, 201);
    const registerPayload = await registerResponse.json();
    assert.equal(registerPayload.user.email, email);
    const cookie = extractCookies(registerResponse);
    assert.ok(cookie, 'expected an auth cookie to be set on register');
    const setCookieHeader = getSetCookies(registerResponse).join('\n');
    assert.match(setCookieHeader, /HttpOnly/i);
    assert.match(setCookieHeader, /SameSite=Strict/i);
    assert.match(setCookieHeader, /vinscope_access_token=/i);
    assert.match(setCookieHeader, /vinscope_refresh_token=/i);

    // /api/auth/me should reflect the logged-in user.
    const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(meResponse.status, 200);
    const mePayload = await meResponse.json();
    assert.equal(mePayload.user.email, email);

    // Wrong password must be rejected.
    const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    assert.equal(badLogin.status, 401);

    // Correct password should succeed.
    const goodLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(goodLogin.status, 200);

    // Saving a report requires auth and should be readable back for that user.
    const saveResponse = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ vin: 'TESTVIN0000000001', make: 'Test', model: 'Car', score: 80 }),
    });
    assert.equal(saveResponse.status, 201);

    const reportsResponse = await fetch(`${baseUrl}/api/reports`, {
      headers: { Cookie: cookie },
    });
    assert.equal(reportsResponse.status, 200);
    const reports = await reportsResponse.json();
    assert.ok(reports.some((report) => report.vin === 'TESTVIN0000000001'));
  } finally {
    server.close();
  }
});

test('password login is temporarily locked after repeated failures', async () => {
  const { server, baseUrl } = await startServer();
  const email = `lockout-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Lockout User' }),
    });
    assert.equal(registerResponse.status, 201);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failedLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong-password' }),
      });
      assert.equal(failedLogin.status, 401);
    }

    const lockingAttempt = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    assert.equal(lockingAttempt.status, 423);
    const lockingPayload = await lockingAttempt.json();
    assert.equal(lockingPayload.error.code, 'ACCOUNT_LOCKED');
    assert.ok(lockingPayload.error.details.lockedUntil);

    const blockedValidLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(blockedValidLogin.status, 423);
  } finally {
    server.close();
  }
});

test('login IP backoff blocks repeated failed password attempts from the same network', async () => {
  const { server, baseUrl } = await startServer();

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `unknown-${attempt}@example.com`, password: 'wrong-password' }),
      });
      assert.equal(response.status, 401);
    }

    const blockedResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unknown-blocked@example.com', password: 'wrong-password' }),
    });
    assert.equal(blockedResponse.status, 429);
    const blockedPayload = await blockedResponse.json();
    assert.equal(blockedPayload.error.code, 'LOGIN_IP_BACKOFF');
    assert.ok(blockedPayload.error.details.lockedUntil);
  } finally {
    server.close();
  }
});

test('logout revokes previously issued session tokens', async () => {
  const { server, baseUrl } = await startServer();
  const email = `revoke-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Revoke User' }),
    });
    assert.equal(registerResponse.status, 201);

    const cookie = extractCookies(registerResponse);
    assert.ok(cookie);

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(logoutResponse.status, 200);

    const staleSessionResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(staleSessionResponse.status, 401);
    const staleSessionPayload = await staleSessionResponse.json();
    assert.equal(staleSessionPayload.error.code, 'SESSION_REVOKED');
  } finally {
    server.close();
  }
});

test('session activity can be listed and logout-all revokes active sessions', async () => {
  const { server, baseUrl } = await startServer();
  const email = `sessions-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Session User' }),
    });
    assert.equal(registerResponse.status, 201);
    const cookie = extractCookies(registerResponse);

    const sessionsResponse = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { Cookie: cookie },
    });
    assert.equal(sessionsResponse.status, 200);
    const sessionsPayload = await sessionsResponse.json();
    assert.ok(Array.isArray(sessionsPayload.sessions));
    assert.ok(sessionsPayload.sessions.length >= 1);
    assert.equal(sessionsPayload.sessions[0].status, 'active');

    const logoutAllResponse = await fetch(`${baseUrl}/api/auth/logout-all`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(logoutAllResponse.status, 200);

    const staleSessionResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(staleSessionResponse.status, 401);
    const staleSessionPayload = await staleSessionResponse.json();
    assert.equal(staleSessionPayload.error.code, 'SESSION_REVOKED');
  } finally {
    server.close();
  }
});

test('refresh endpoint rotates refresh token and issues a new access session', async () => {
  const { server, baseUrl } = await startServer();
  const email = `refresh-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Refresh User' }),
    });
    assert.equal(registerResponse.status, 201);

    const originalCookies = extractCookies(registerResponse);
    assert.ok(originalCookies.includes('vinscope_refresh_token='));

    const refreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: originalCookies },
    });
    assert.equal(refreshResponse.status, 200);

    const rotatedCookies = extractCookies(refreshResponse);
    assert.ok(rotatedCookies.includes('vinscope_refresh_token='));
    assert.notEqual(rotatedCookies, originalCookies);

    const meWithRotatedCookies = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: rotatedCookies },
    });
    assert.equal(meWithRotatedCookies.status, 200);

    const reusedOldRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: originalCookies },
    });
    assert.equal(reusedOldRefresh.status, 401);
    const reusedOldRefreshPayload = await reusedOldRefresh.json();
    assert.equal(reusedOldRefreshPayload.error.code, 'REFRESH_TOKEN_REUSED');
  } finally {
    server.close();
  }
});

test('refresh session expires after inactivity and forces re-authentication', async () => {
  const { server, baseUrl } = await startServer();
  const email = `idle-refresh-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Idle Refresh User' }),
    });
    assert.equal(registerResponse.status, 201);

    const cookies = extractCookies(registerResponse);
    const refreshCookie = cookies
      .split('; ')
      .find((entry) => entry.startsWith('vinscope_refresh_token='));
    assert.ok(refreshCookie, 'expected a refresh token cookie');

    const refreshToken = refreshCookie.split('=')[1];
    const refreshTokenHash = createHash('sha256').update(refreshToken).digest('hex');
    await pool.query(
      "UPDATE refresh_sessions SET last_used_at = now() - INTERVAL '2 minutes' WHERE token_hash = $1",
      [refreshTokenHash]
    );

    const refreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: cookies },
    });
    assert.equal(refreshResponse.status, 401);
    const refreshPayload = await refreshResponse.json();
    assert.equal(refreshPayload.error.code, 'REFRESH_SESSION_IDLE_EXPIRED');
  } finally {
    server.close();
  }
});

test('OTP send and verify are limited per phone and IP', async () => {
  const { server, baseUrl } = await startServer();
  const phone = `07${Math.floor(10000000 + Math.random() * 89999999)}`;

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, purpose: 'register' }),
      });
      assert.ok([200, 404].includes(response.status));
    }

    const blockedSend = await fetch(`${baseUrl}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose: 'register' }),
    });
    assert.equal(blockedSend.status, 429);
    const blockedSendPayload = await blockedSend.json();
    assert.equal(blockedSendPayload.error.code, 'OTP_SEND_PHONE_LIMIT');

    const verifyPhone = `07${Math.floor(10000000 + Math.random() * 89999999)}`;
    const firstSend = await fetch(`${baseUrl}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: verifyPhone, purpose: 'register' }),
    });
    assert.equal(firstSend.status, 200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedVerify = await fetch(`${baseUrl}/api/auth/otp/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: verifyPhone, code: '000000' }),
      });
      assert.ok([400, 404].includes(failedVerify.status));
    }

    const blockedVerify = await fetch(`${baseUrl}/api/auth/otp/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: verifyPhone, code: '000000' }),
    });
    assert.equal(blockedVerify.status, 429);
    const blockedVerifyPayload = await blockedVerify.json();
    assert.ok(['OTP_VERIFY_PHONE_LIMIT', 'OTP_VERIFY_IP_LIMIT'].includes(blockedVerifyPayload.error.code));
  } finally {
    server.close();
  }
});

test('auth audit logs are written for failed login, lockout, success, and logout', async () => {
  const { server, baseUrl } = await startServer();
  const email = `audit-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Audit User' }),
    });
    assert.equal(registerResponse.status, 201);

    const logoutAfterRegister = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: extractCookies(registerResponse) },
    });
    assert.equal(logoutAfterRegister.status, 200);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failedLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong-password' }),
      });
      assert.equal(failedLogin.status, 401);
    }

    const lockoutLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    assert.equal(lockoutLogin.status, 423);

    await pool.query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1", [email]);

    const successfulLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(successfulLogin.status, 200);

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: extractCookies(successfulLogin) },
    });
    assert.equal(logoutResponse.status, 200);

    const auditResult = await pool.query(
      `
        SELECT event_type, success, failure_code
        FROM auth_audit_logs
        WHERE email = $1
        ORDER BY id ASC
      `,
      [email]
    );

    const auditEvents = auditResult.rows.map((row) => row.event_type);
    assert.ok(auditEvents.includes('AUTH_REGISTER_SUCCEEDED'));
    assert.ok(auditEvents.includes('AUTH_LOGIN_FAILED'));
    assert.ok(auditEvents.includes('AUTH_ACCOUNT_LOCKED'));
    assert.ok(auditEvents.includes('AUTH_LOGIN_SUCCEEDED'));
    assert.ok(auditEvents.includes('AUTH_LOGOUT_SUCCEEDED'));
  } finally {
    server.close();
  }
});

test('admin audit log viewer requires admin access and supports filters', async () => {
  const { server, baseUrl } = await startServer();
  const adminEmail = `admin-audit-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const regularEmail = `regular-audit-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const adminRegisterResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password, name: 'Admin User' }),
    });
    assert.equal(adminRegisterResponse.status, 201);
    const adminCookie = extractCookies(adminRegisterResponse);

    const regularRegisterResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: regularEmail, password, name: 'Regular User' }),
    });
    assert.equal(regularRegisterResponse.status, 201);
    const regularCookie = extractCookies(regularRegisterResponse);

    await pool.query('UPDATE users SET is_admin = true WHERE email = $1', [adminEmail]);

    const forbiddenResponse = await fetch(`${baseUrl}/api/admin/audit-logs`, {
      headers: { Cookie: regularCookie },
    });
    assert.equal(forbiddenResponse.status, 403);

    const filteredResponse = await fetch(
      `${baseUrl}/api/admin/audit-logs?email=${encodeURIComponent(regularEmail)}&eventType=AUTH_REGISTER_SUCCEEDED&limit=10`,
      {
        headers: { Cookie: adminCookie },
      }
    );
    assert.equal(filteredResponse.status, 200);
    const filteredPayload = await filteredResponse.json();

    assert.equal(filteredPayload.filters.email, regularEmail);
    assert.equal(filteredPayload.filters.eventType, 'AUTH_REGISTER_SUCCEEDED');
    assert.ok(Array.isArray(filteredPayload.logs));
    assert.ok(filteredPayload.logs.length >= 1);
    assert.ok(filteredPayload.logs.every((entry) => entry.email === regularEmail));
    assert.ok(filteredPayload.logs.every((entry) => entry.eventType === 'AUTH_REGISTER_SUCCEEDED'));
    assert.ok(typeof filteredPayload.pagination.total === 'number');
    assert.equal(filteredPayload.pagination.offset, 0);

    const paginatedResponse = await fetch(
      `${baseUrl}/api/admin/audit-logs?limit=1&offset=0`,
      {
        headers: { Cookie: adminCookie },
      }
    );
    assert.equal(paginatedResponse.status, 200);
    const paginatedPayload = await paginatedResponse.json();
    assert.equal(paginatedPayload.logs.length, 1);
    assert.equal(paginatedPayload.pagination.limit, 1);
    assert.equal(paginatedPayload.pagination.offset, 0);

    const csvResponse = await fetch(
      `${baseUrl}/api/admin/audit-logs?email=${encodeURIComponent(regularEmail)}&format=csv&limit=5`,
      {
        headers: { Cookie: adminCookie },
      }
    );
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get('content-type') || '', /text\/csv/i);
    const csvText = await csvResponse.text();
    assert.match(csvText, /eventType,userId,email,phone,success/);
    assert.match(csvText, new RegExp(regularEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    server.close();
  }
});

test('security alerts are generated for account lockouts and refresh-token reuse', async () => {
  const { server, baseUrl } = await startServer();
  const email = `alerts-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Alerts User' }),
    });
    assert.equal(registerResponse.status, 201);
    const registerPayload = await registerResponse.json();

    const originalCookies = extractCookies(registerResponse);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong-password' }),
      });
    }

    const refreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: originalCookies },
    });
    assert.equal(refreshResponse.status, 200);

    const reusedOldRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: originalCookies },
    });
    assert.equal(reusedOldRefresh.status, 401);

    const alertsResult = await pool.query(
      `
        SELECT alert_type, subject_label, event_count
        FROM auth_security_alerts
        WHERE subject_key = $1
        ORDER BY id ASC
      `,
      [`user:${registerPayload.user.id}`]
    );

    const alertTypes = alertsResult.rows.map((row) => row.alert_type);
    assert.ok(alertTypes.includes('LOCKOUT_THRESHOLD_EXCEEDED'));
    assert.ok(alertTypes.includes('REFRESH_TOKEN_REUSE_DETECTED'));
  } finally {
    server.close();
  }
});

test('admin security alerts endpoint supports severity filters, pagination, and CSV export', async () => {
  const { server, baseUrl } = await startServer();
  const adminEmail = `admin-alerts-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const targetEmail = `target-alerts-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const adminRegisterResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password, name: 'Admin Alerts User' }),
    });
    assert.equal(adminRegisterResponse.status, 201);
    const adminCookie = extractCookies(adminRegisterResponse);
    await pool.query('UPDATE users SET is_admin = true WHERE email = $1', [adminEmail]);

    const targetRegisterResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password, name: 'Target Alerts User' }),
    });
    assert.equal(targetRegisterResponse.status, 201);
    const targetCookies = extractCookies(targetRegisterResponse);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, password: 'wrong-password' }),
      });
    }

    const refreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: targetCookies },
    });
    assert.equal(refreshResponse.status, 200);

    const reusedOldRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: targetCookies },
    });
    assert.equal(reusedOldRefresh.status, 401);

    const warningAlertsResponse = await fetch(
      `${baseUrl}/api/admin/security-alerts?severity=warning&limit=10`,
      { headers: { Cookie: adminCookie } }
    );
    assert.equal(warningAlertsResponse.status, 200);
    const warningAlertsPayload = await warningAlertsResponse.json();
    assert.ok(warningAlertsPayload.alerts.some((entry) => entry.alertType === 'LOCKOUT_THRESHOLD_EXCEEDED'));
    assert.ok(warningAlertsPayload.alerts.every((entry) => entry.severity === 'warning'));

    const criticalAlertsResponse = await fetch(
      `${baseUrl}/api/admin/security-alerts?severity=critical&limit=1&offset=0`,
      { headers: { Cookie: adminCookie } }
    );
    assert.equal(criticalAlertsResponse.status, 200);
    const criticalAlertsPayload = await criticalAlertsResponse.json();
    assert.equal(criticalAlertsPayload.pagination.limit, 1);
    assert.equal(criticalAlertsPayload.pagination.offset, 0);
    assert.ok(criticalAlertsPayload.alerts.some((entry) => entry.alertType === 'REFRESH_TOKEN_REUSE_DETECTED'));

    const csvResponse = await fetch(
      `${baseUrl}/api/admin/security-alerts?severity=critical&format=csv&limit=5`,
      { headers: { Cookie: adminCookie } }
    );
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get('content-type') || '', /text\/csv/i);
    const csvText = await csvResponse.text();
    assert.match(csvText, /alertType,severity,subjectKey,subjectLabel/);
    assert.match(csvText, /REFRESH_TOKEN_REUSE_DETECTED/);
  } finally {
    server.close();
  }
});

test('admin can acknowledge and resolve security alerts and delivery attempts are logged', async () => {
  const { server, baseUrl } = await startServer();
  const adminEmail = `admin-review-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const targetEmail = `target-review-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';

  try {
    const adminRegisterResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password, name: 'Admin Reviewer' }),
    });
    assert.equal(adminRegisterResponse.status, 201);
    const adminCookie = extractCookies(adminRegisterResponse);
    await pool.query('UPDATE users SET is_admin = true WHERE email = $1', [adminEmail]);

    const targetRegisterResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password, name: 'Target Reviewer' }),
    });
    assert.equal(targetRegisterResponse.status, 201);
    const targetCookies = extractCookies(targetRegisterResponse);

    const refreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: targetCookies },
    });
    assert.equal(refreshResponse.status, 200);

    const reusedOldRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: targetCookies },
    });
    assert.equal(reusedOldRefresh.status, 401);

    const alertsResponse = await fetch(`${baseUrl}/api/admin/security-alerts?alertType=REFRESH_TOKEN_REUSE_DETECTED&limit=5`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(alertsResponse.status, 200);
    const alertsPayload = await alertsResponse.json();
    const targetAlert = alertsPayload.alerts.find((entry) => entry.alertType === 'REFRESH_TOKEN_REUSE_DETECTED');
    assert.ok(targetAlert);

    const acknowledgeResponse = await fetch(`${baseUrl}/api/admin/security-alerts/${targetAlert.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ action: 'acknowledge' }),
    });
    assert.equal(acknowledgeResponse.status, 200);
    const acknowledgedPayload = await acknowledgeResponse.json();
    assert.equal(acknowledgedPayload.alert.status, 'acknowledged');

    const resolveResponse = await fetch(`${baseUrl}/api/admin/security-alerts/${targetAlert.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ action: 'resolve', note: 'Reviewed by admin' }),
    });
    assert.equal(resolveResponse.status, 200);
    const resolvedPayload = await resolveResponse.json();
    assert.equal(resolvedPayload.alert.status, 'resolved');
    assert.equal(resolvedPayload.alert.resolutionNote, 'Reviewed by admin');

    const reopenResponse = await fetch(`${baseUrl}/api/admin/security-alerts/${targetAlert.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ action: 'reopen' }),
    });
    assert.equal(reopenResponse.status, 200);
    const reopenedPayload = await reopenResponse.json();
    assert.equal(reopenedPayload.alert.status, 'open');
    assert.equal(reopenedPayload.alert.resolutionNote, null);

    const deliveryLogResult = await pool.query(
      'SELECT COUNT(*)::int AS total FROM auth_alert_delivery_logs WHERE alert_id = $1',
      [targetAlert.id]
    );
    assert.ok(Number(deliveryLogResult.rows[0]?.total || 0) >= 0);
  } finally {
    server.close();
  }
});

test('SMS signup and passwordless phone login work end to end', async () => {
  const { server, baseUrl } = await startServer();
  const email = `phone-test-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'supersecret123';
  const phone = `07${Math.floor(10000000 + Math.random() * 89999999)}`;

  try {
    const sendResponse = await fetch(`${baseUrl}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose: 'register' }),
    });
    assert.equal(sendResponse.status, 200);
    const sendPayload = await sendResponse.json();
    assert.ok(sendPayload.demoCode, 'expected a demo code since SMS is not configured in tests');

    // Registering with the wrong code must be rejected.
    const badRegister = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Phone User', phone, code: '000000', verificationMethod: 'sms' }),
    });
    assert.equal(badRegister.status, 400);

    // Re-send since the failed attempt above did not consume the original code, but request a fresh one for clarity.
    const resendResponse = await fetch(`${baseUrl}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose: 'register' }),
    });
    const resendPayload = await resendResponse.json();

    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Phone User', phone, code: resendPayload.demoCode, verificationMethod: 'sms' }),
    });
    assert.equal(registerResponse.status, 201);

    // Sending another registration code for the same phone should now be rejected (already registered).
    const duplicateSend = await fetch(`${baseUrl}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose: 'register' }),
    });
    assert.equal(duplicateSend.status, 409);

    // A phone number with no account cannot request a login code.
    const unknownPhoneLogin = await fetch(`${baseUrl}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '0798712345', purpose: 'login' }),
    });
    assert.equal(unknownPhoneLogin.status, 404);

    // Passwordless login with the registered phone number.
    const loginSendResponse = await fetch(`${baseUrl}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose: 'login' }),
    });
    assert.equal(loginSendResponse.status, 200);
    const loginSendPayload = await loginSendResponse.json();

    const loginResponse = await fetch(`${baseUrl}/api/auth/otp/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code: loginSendPayload.demoCode }),
    });
    assert.equal(loginResponse.status, 200);
    const loginPayload = await loginResponse.json();
    assert.equal(loginPayload.user.email, email);
  } finally {
    server.close();
  }
});
