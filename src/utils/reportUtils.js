export const filterSavedReports = (reports, query = '') => {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) return reports;

  return reports.filter((report) => {
    const searchableText = [
      report.vin,
      report.make,
      report.model,
      report.year,
      report.score,
      report.status,
      report.ownership,
      report.accidents,
      report.theft,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return searchableText.includes(normalizedQuery);
  });
};

export const buildComparisonChartData = (reports = []) => {
  return reports.map((report, index) => ({
    id: report.vin || `${report.make}-${index}`,
    label: `${report.make || 'Vehicle'} ${report.model || ''}`.trim(),
    score: Number(report.score) || 0,
    rating: Number(report.score) >= 70 ? 'strong' : 'risk',
  }));
};

export const buildVehicleHistorySections = (report = {}) => {
  const normalizedScore = Number(report.score) || 0;

  return [
    {
      key: 'theft',
      title: 'Theft history',
      value: report.theft || 'No theft data available',
      tone: /no|clear|none/i.test(report.theft || '') ? 'ok' : 'warn',
    },
    {
      key: 'ownership',
      title: 'Ownership history',
      value: report.ownership || 'Ownership details unavailable',
      tone: 'neutral',
    },
    {
      key: 'accidents',
      title: 'Accident history',
      value: report.accidents || 'No accident data available',
      tone: /no|none|minor/i.test(report.accidents || '') ? 'ok' : 'warn',
    },
    {
      key: 'mileage',
      title: 'Mileage trend',
      value: report.mileage || 'Mileage data unavailable',
      tone: /consistent|appears/i.test(report.mileage || '') ? 'ok' : 'warn',
    },
    {
      key: 'score',
      title: 'Risk score history',
      value: `${normalizedScore}/100`,
      tone: normalizedScore >= 70 ? 'ok' : 'warn',
    },
  ];
};
