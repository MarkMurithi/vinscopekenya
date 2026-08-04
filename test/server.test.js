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

  listeningServer.close();
});
