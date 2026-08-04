export const getDefaultAnalytics = () => ({
  totalSearches: 0,
  planPopularity: {
    Starter: 0,
    Pro: 0,
    Business: 0,
  },
});

export const recordVinSearch = (analytics = getDefaultAnalytics()) => ({
  ...analytics,
  totalSearches: (analytics.totalSearches || 0) + 1,
});

export const recordPlanSelection = (analytics = getDefaultAnalytics(), planName) => {
  if (!planName) return analytics;

  return {
    ...analytics,
    planPopularity: {
      ...analytics.planPopularity,
      [planName]: (analytics.planPopularity?.[planName] || 0) + 1,
    },
  };
};

export const getPopularPlan = (analytics = getDefaultAnalytics()) => {
  const entries = Object.entries(analytics.planPopularity || {});
  if (!entries.length) return 'No data yet';

  const [name, count] = entries.reduce((best, current) => (current[1] > best[1] ? current : best), entries[0]);
  return `${name} (${count})`;
};
