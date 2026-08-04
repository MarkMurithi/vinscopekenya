import test from 'node:test';
import assert from 'node:assert/strict';
import { app, pool } from '../server.js';

test('health endpoint responds and database pool can connect', async () => {
  const response = await fetch('http://127.0.0.1:5000/health');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.database, 'postgres');
  assert.equal(payload.ok, true);

  const result = await pool.query('SELECT 1 as value');
  assert.equal(result.rows[0].value, 1);
});
