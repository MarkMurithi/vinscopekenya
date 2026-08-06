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

export const getScoreTier = (score) => {
  const value = Number(score);

  if (!Number.isFinite(value)) return { label: 'Not rated', tone: 'unknown' };
  if (value >= 85) return { label: 'Excellent', tone: 'ok' };
  if (value >= 70) return { label: 'Good', tone: 'ok' };
  if (value >= 50) return { label: 'Fair', tone: 'caution' };
  return { label: 'Poor', tone: 'warn' };
};

export const buildComparisonChartData = (reports = []) => {
  return reports.map((report, index) => ({
    id: report.vin || `${report.make}-${index}`,
    label: `${report.make || 'Vehicle'} ${report.model || ''}`.trim(),
    score: Number(report.score) || 0,
    rating: Number(report.score) >= 70 ? 'strong' : 'risk',
  }));
};

const KENYA_LOCATIONS = [
  'Nairobi CBD', 'Mombasa Road, Nairobi', 'Thika Superhighway', 'Westlands, Nairobi',
  'Nakuru Town', 'Eldoret', 'Kisumu', 'Mombasa Island', 'Machakos', 'Nyeri', 'Kiambu Road', 'Naivasha',
];

const KENYA_FIRST_NAMES = [
  'James', 'Mary', 'Peter', 'Grace', 'John', 'Faith', 'David', 'Ann', 'Samuel', 'Esther',
  'Daniel', 'Joyce', 'Michael', 'Lucy', 'Joseph', 'Susan', 'Brian', 'Caroline', 'Kevin', 'Purity',
  'Dennis', 'Beatrice', 'Anthony', 'Winnie', 'Charles', 'Agnes', 'Patrick', 'Mercy', 'George', 'Nancy',
];

const KENYA_LAST_NAMES = [
  'Mwangi', 'Otieno', 'Wanjiru', 'Kamau', 'Achieng', 'Kariuki', 'Njoroge', 'Odhiambo', 'Wafula', 'Cheruiyot',
  'Mutua', 'Wambui', 'Kiptoo', 'Nyambura', 'Omondi', 'Njeri', 'Kimani', 'Auma', 'Barasa', 'Chebet',
];

const KENYA_PHONE_PREFIXES = ['070', '071', '072', '074', '079', '011', '010'];

// Deterministic (VIN-seeded) pseudo-random generator so the same vehicle always
// shows the same incident details instead of a new fake history on every render.
const hashString = (value) => {
  let hash = 0;
  const str = String(value || '');
  for (let i = 0; i < str.length; i += 1) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
};

const seededRandom = (seed) => {
  let value = seed % 2147483647;
  if (value <= 0) value += 2147483646;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
};

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

const randomDate = (rand, yearsAgoMax) => {
  const now = new Date();
  const year = now.getFullYear() - 1 - Math.floor(rand() * yearsAgoMax);
  const month = String(Math.floor(rand() * 12) + 1).padStart(2, '0');
  const day = String(Math.floor(rand() * 27) + 1).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const extractCount = (text = '', defaultWhenUnclear = 0) => {
  const match = String(text).match(/(\d+)/);
  if (match) return Number(match[1]);
  if (/single|one owner/i.test(text)) return 1;
  if (/no |none|clear/i.test(text)) return 0;
  return defaultWhenUnclear;
};

const randomOwnerName = (rand) => `${pick(rand, KENYA_FIRST_NAMES)} ${pick(rand, KENYA_LAST_NAMES)}`;

const randomOwnerPhone = (rand) => {
  const prefix = pick(rand, KENYA_PHONE_PREFIXES);
  const rest = String(Math.floor(rand() * 1000000)).padStart(6, '0');
  return `+254 ${prefix.slice(1)}${rest.slice(0, 1)} ${rest.slice(1, 4)} ${rest.slice(4)}`;
};

// Builds an ascending list of ownership-transfer dates (registration + every
// change of hands) so each previous owner's purchase/sale dates stay in order.
const buildOwnershipDates = (rand, ownerCount) => {
  const dates = Array.from({ length: ownerCount }, () => randomDate(rand, 9));
  return dates.sort();
};

// Builds structured, per-incident detail (date, location, outcome, reporting source)
// for the theft/accident/ownership summary fields shown on a report, so each summary
// can be expanded into the underlying record(s) it represents.
export const buildIncidentRecords = (report = {}) => {
  const rand = seededRandom(hashString(report.vin));

  const theftFlagged = /flag|stolen|report/i.test(report.theft || '') && !/no /i.test(report.theft || '');
  const theft = theftFlagged
    ? [{
        id: 'theft-1',
        dateRecorded: randomDate(rand, 5),
        location: pick(rand, KENYA_LOCATIONS),
        outcome: pick(rand, ['Vehicle recovered', 'Recovered with minor damage', 'Case under investigation', 'Closed - insurance settled']),
        reportedBy: pick(rand, ['National Police Service', 'Insurance underwriter', 'DCI Auto Theft Unit']),
        description: 'Vehicle was reported stolen and flagged in a national theft database.',
      }]
    : [];

  const accidentCount = extractCount(report.accidents, 0);
  const accidents = Array.from({ length: accidentCount }).map((_, index) => {
    const severity = pick(rand, ['Minor', 'Moderate', 'Major']);
    return {
      id: `accident-${index + 1}`,
      dateRecorded: randomDate(rand, 6),
      location: pick(rand, KENYA_LOCATIONS),
      severity,
      outcome: severity === 'Major' ? 'Vehicle repaired - structural repair recorded' : 'Vehicle repaired - panel/cosmetic repair',
      reportedBy: pick(rand, ['Insurance claim', 'Police accident report', 'Authorized body shop record']),
      description: `${severity} collision reported, with repair work logged afterwards.`,
    };
  });

  const ownerCount = extractCount(report.ownership, /single/i.test(report.ownership || '') ? 1 : 1);
  const transferCount = Math.max(ownerCount - 1, 0);
  const ownershipDates = buildOwnershipDates(rand, transferCount + 1);
  const ownership = Array.from({ length: transferCount }).map((_, index) => {
    const purchaseDate = ownershipDates[index];
    const saleDate = ownershipDates[index + 1];
    const ownerName = randomOwnerName(rand);
    const ownerPhone = randomOwnerPhone(rand);
    return {
      id: `ownership-${index + 1}`,
      ownerNumber: index + 1,
      ownerName,
      ownerPhone,
      purchaseDate,
      saleDate,
      dateRecorded: saleDate,
      location: pick(rand, KENYA_LOCATIONS),
      outcome: 'Ownership transfer registered',
      reportedBy: 'National Transport and Safety Authority (NTSA)',
      description: `Owner ${index + 1}, ${ownerName}, sold the vehicle after registering it as the transfer of ownership.`,
    };
  });

  return { theft, accidents, ownership };
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
