const STORAGE_KEY = 'vinscope-demo-store';

const defaultState = {
  users: [
    {
      id: 'demo-user',
      name: 'Demo Buyer',
      email: 'demo@vinscope.com',
      password: 'demo123',
    },
  ],
  reports: [],
};

function readStore() {
  if (typeof window === 'undefined') {
    return defaultState;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultState));
      return defaultState;
    }

    const parsed = JSON.parse(stored);
    return {
      users: parsed.users ?? defaultState.users,
      reports: parsed.reports ?? [],
    };
  } catch (error) {
    return defaultState;
  }
}

function writeStore(nextState) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export function loginUser(email, password) {
  const state = readStore();
  const normalizedEmail = normalizeEmail(email);
  const user = state.users.find((entry) => normalizeEmail(entry.email) === normalizedEmail && entry.password === password);

  if (!user) {
    return { success: false, message: 'Invalid email or password.' };
  }

  return { success: true, user: { ...user, email: user.email } };
}

export function registerUser(email, password, name) {
  const state = readStore();
  const normalizedEmail = normalizeEmail(email);
  const exists = state.users.some((entry) => normalizeEmail(entry.email) === normalizedEmail);

  if (exists) {
    return { success: false, message: 'An account with that email already exists.' };
  }

  const newUser = {
    id: `user-${Date.now()}`,
    name: name || 'New Buyer',
    email,
    password,
  };

  const nextState = {
    ...state,
    users: [...state.users, newUser],
  };
  writeStore(nextState);

  return { success: true, user: newUser };
}

export function saveVehicleReport(report, ownerEmail) {
  if (!ownerEmail) {
    return;
  }

  const state = readStore();
  const nextReport = {
    id: `report-${Date.now()}`,
    ownerEmail: normalizeEmail(ownerEmail),
    savedAt: new Date().toISOString(),
    ...report,
  };

  const nextState = {
    ...state,
    reports: [nextReport, ...state.reports.filter((entry) => entry.ownerEmail !== normalizeEmail(ownerEmail) || entry.vin !== report.vin)].slice(0, 8),
  };
  writeStore(nextState);
}

export function getVehicleReports(ownerEmail) {
  if (!ownerEmail) {
    return [];
  }

  const state = readStore();
  return state.reports.filter((entry) => normalizeEmail(entry.ownerEmail) === normalizeEmail(ownerEmail));
}
