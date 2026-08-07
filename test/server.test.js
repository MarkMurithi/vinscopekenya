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
