import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.NODE_ENV = 'test';
const { app, initializeDatabase } = await import('../server.js');
await initializeDatabase();

let server;

async function startServer() {
  server = app.listen(0);
  await once(server, 'listening');
  return server;
}

test('health endpoint and VIN lookup work', async () => {
  const listeningServer = await startServer();
  const address = listeningServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  const healthPayload = await healthResponse.json();
  assert.equal(healthPayload.ok, true);

  const vehicleResponse = await fetch(`${baseUrl}/api/vehicles/JTEBU5JR3K5001234`);
  assert.equal(vehicleResponse.status, 200);
  const vehiclePayload = await vehicleResponse.json();
  assert.equal(vehiclePayload.vin, 'JTEBU5JR3K5001234');

  const highRiskResponse = await fetch(`${baseUrl}/api/vehicles/1HGCM82633A004352`);
  assert.equal(highRiskResponse.status, 200);
  const highRiskPayload = await highRiskResponse.json();

  // Theft record + accidents + mileage inconsistency + many previous owners should reduce score heavily.
  assert.ok(highRiskPayload.score < vehiclePayload.score);

  const singleOwnerResponse = await fetch(`${baseUrl}/api/vehicles/MBHDC9EAXPC123456`);
  assert.equal(singleOwnerResponse.status, 200);
  const singleOwnerPayload = await singleOwnerResponse.json();

  const multiOwnerResponse = await fetch(`${baseUrl}/api/vehicles/JT2UP2HWWJ0LUW7F1`);
  assert.equal(multiOwnerResponse.status, 200);
  const multiOwnerPayload = await multiOwnerResponse.json();

  // With other risk factors clean, more previous owners should still lower the score.
  assert.ok(singleOwnerPayload.score > multiOwnerPayload.score);

  listeningServer.close();
});

test('API errors include a request id and standardized error payload', async () => {
  const listeningServer = await startServer();
  const address = listeningServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/vehicles/SHORTVIN`);
    assert.equal(response.status, 400);
    assert.ok(response.headers.get('x-request-id'));

    const payload = await response.json();
    assert.equal(payload.error.code, 'INVALID_VIN_FORMAT');
    assert.ok(payload.error.message.includes('Invalid VIN format'));
    assert.equal(payload.error.requestId, response.headers.get('x-request-id'));
    assert.equal(payload.error.details.vin, 'SHORTVIN');
  } finally {
    listeningServer.close();
  }
});

test('client error sink accepts browser error reports and persists them', async () => {
  const listeningServer = await startServer();
  const address = listeningServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'render_error',
        severity: 'error',
        message: 'Test client render failure',
        stack: 'Error: Test client render failure',
        componentStack: 'at App',
        href: 'http://localhost:5173/',
      }),
    });

    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.ok, true);

    const { rows } = await pool.query(
      `
        SELECT source, category, message
        FROM app_error_events
        WHERE source = 'client' AND message = $1
        ORDER BY id DESC
        LIMIT 1
      `,
      ['Test client render failure']
    );

    assert.equal(rows[0].source, 'client');
    assert.equal(rows[0].category, 'render_error');
  } finally {
    listeningServer.close();
  }
});

test('unknown API routes return the standardized 404 payload', async () => {
  const listeningServer = await startServer();
  const address = listeningServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(response.status, 404);

    const payload = await response.json();
    assert.equal(payload.error.code, 'API_ROUTE_NOT_FOUND');
    assert.equal(payload.error.requestId, response.headers.get('x-request-id'));
    assert.equal(payload.error.details.method, 'GET');
    assert.equal(payload.error.details.path, '/api/does-not-exist');
  } finally {
    listeningServer.close();
  }
});
