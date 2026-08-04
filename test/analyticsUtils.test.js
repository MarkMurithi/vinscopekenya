import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDefaultAnalytics,
  recordVinSearch,
  recordPlanSelection,
  getPopularPlan,
} from '../src/utils/analyticsUtils.js';

test('recordVinSearch increments total searches', () => {
  const analytics = getDefaultAnalytics();

  const next = recordVinSearch(analytics);

  assert.equal(next.totalSearches, 1);
});

test('recordPlanSelection updates plan popularity counts', () => {
  const analytics = getDefaultAnalytics();

  const next = recordPlanSelection(analytics, 'Pro');

  assert.equal(next.planPopularity.Pro, 1);
  assert.equal(next.planPopularity.Starter, 0);
});

test('getPopularPlan reports the most selected plan', () => {
  const analytics = {
    ...getDefaultAnalytics(),
    planPopularity: { Starter: 1, Pro: 3, Business: 2 },
  };

  assert.equal(getPopularPlan(analytics), 'Pro (3)');
});
