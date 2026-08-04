import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.NODE_ENV = 'test';
const { app, pool, initializeDatabase } = await import('../server.js');
await initializeDatabase();

test('health endpoint responds and database pool can connect', async () => {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.database, 'postgres');
  assert.equal(payload.ok, true);

  const result = await pool.query('SELECT 1 as value');
  assert.equal(result.rows[0].value, 1);

  server.close();
});
