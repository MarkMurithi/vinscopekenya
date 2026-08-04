import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { app, initializeDatabase } = await import('../server.js');
await initializeDatabase();

async function startServer() {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  return setCookie ? setCookie.split(';')[0] : null;
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
    const cookie = extractCookie(registerResponse);
    assert.ok(cookie, 'expected an auth cookie to be set on register');

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
