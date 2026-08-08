import assert from 'node:assert/strict';
import test from 'node:test';

import { findSecretViolations } from '../scripts/check-env-example-secrets.mjs';

test('allows empty protected values and safe local defaults', () => {
  const contents = [
    'JWT_SECRET=',
    'MPESA_CONSUMER_KEY=""',
    'PORT=5000',
    'DATABASE_URL=postgres://postgres:postgres@localhost:5432/vinscope',
  ].join('\n');

  assert.deepEqual(findSecretViolations(contents), []);
});

test('rejects populated protected values', () => {
  const violations = findSecretViolations([
    'JWT_SECRET=not-a-real-secret',
    'ADMIN_EMAILS=admin@example.com',
  ].join('\n'));

  assert.deepEqual(violations, [
    'line 1: JWT_SECRET must be empty',
    'line 2: ADMIN_EMAILS must be empty',
  ]);
});

test('rejects recognizable secrets in any variable', () => {
  const violations = findSecretViolations(
    'UNEXPECTED_VALUE=https://hooks.slack.com/services/FAKE/TEST/VALUE',
  );

  assert.deepEqual(violations, [
    'line 1: UNEXPECTED_VALUE contains a Slack webhook',
  ]);
});