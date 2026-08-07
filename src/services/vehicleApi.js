const DEFAULT_BASE_URL = import.meta.env.DEV ? 'http://localhost:5000' : '';
const baseUrl = import.meta.env.VITE_VEHICLE_API_URL || DEFAULT_BASE_URL;
export const apiBaseUrl = baseUrl;
let refreshInFlight = null;
let authFailureHandler = null;
const FORCED_LOGOUT_CODES = new Set([
  'SESSION_REVOKED',
  'REFRESH_TOKEN_REUSED',
  'REFRESH_TOKEN_EXPIRED',
  'REFRESH_SESSION_IDLE_EXPIRED',
]);

export function setAuthFailureHandler(handler) {
  authFailureHandler = handler;
}

const shouldAttemptRefresh = (path, options = {}) => {
  if (options.skipAuthRefresh) return false;
  return ![
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/logout',
    '/api/auth/refresh',
    '/api/auth/otp/send',
    '/api/auth/otp/login',
  ].includes(path);
};

async function refreshAuthSession() {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    })
      .then(async (response) => {
        if (response.ok) return { ok: true };
        const payload = await response.json().catch(() => null);
        return {
          ok: false,
          code: payload?.error?.code || null,
          message: payload?.error?.message || 'Session refresh failed.',
        };
      })
      .catch(() => ({ ok: false, code: null, message: 'Session refresh failed.' }))
      .finally(() => {
        refreshInFlight = null;
      });
  }

  return refreshInFlight;
}

export async function requestJson(path, options = {}, hasRetriedAfterRefresh = false) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });

  const data = await response.json().catch(() => null);

  if (response.status === 401 && !hasRetriedAfterRefresh && shouldAttemptRefresh(path, options)) {
    const refreshed = await refreshAuthSession();
    if (refreshed.ok) {
      return requestJson(path, { ...options, skipAuthRefresh: true }, true);
    }

    if (FORCED_LOGOUT_CODES.has(refreshed.code) && typeof authFailureHandler === 'function') {
      authFailureHandler({ code: refreshed.code, message: refreshed.message });
    }
  }

  if (!response.ok) {
    const apiError = data?.error;
    const message = apiError?.message || apiError || response.statusText || 'Request failed';
    const error = new Error(message);
    error.status = response.status;
    error.code = apiError?.code || null;
    error.requestId = apiError?.requestId || response.headers.get('x-request-id');
    error.details = apiError?.details || null;
    if (FORCED_LOGOUT_CODES.has(error.code) && typeof authFailureHandler === 'function') {
      authFailureHandler({ code: error.code, message: error.message });
    }
    throw error;
  }

  return data;
}

export async function lookupVehicleByVin(vin) {
  return requestJson(`/api/vehicles/${encodeURIComponent(vin)}`);
}

export async function pingVehicleApi() {
  try {
    return await requestJson('/health');
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
