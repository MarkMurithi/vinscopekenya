import { apiBaseUrl, requestJson } from './vehicleApi';

// Real, server-backed auth against Postgres (bcrypt-hashed passwords + an httpOnly JWT cookie).
// Replaces the old localStorage-based mockApi.js.

export async function registerUser(email, password, name, phone, code, verificationMethod, acceptedTerms, acceptedPrivacy) {
  try {
    const data = await requestJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name, phone, code, verificationMethod, acceptedTerms, acceptedPrivacy }),
    });
    return { success: true, user: data.user };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

export async function sendPhoneOtp(phone, purpose = 'register') {
  try {
    const data = await requestJson('/api/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({ phone, purpose }),
    });
    return { success: true, ...data };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

export async function loginWithPhoneOtp(phone, code) {
  try {
    const data = await requestJson('/api/auth/otp/login', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
    return { success: true, user: data.user };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

export async function loginUser(email, password) {
  try {
    const data = await requestJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return { success: true, user: data.user };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

export async function logoutUser() {
  try {
    await requestJson('/api/auth/logout', { method: 'POST' });
  } catch {
    // Ignore - cookie is short-lived anyway.
  }
}

export async function logoutAllDevices() {
  try {
    await requestJson('/api/auth/logout-all', { method: 'POST' });
  } catch {
    // Ignore - local auth state is still cleared by the caller.
  }
}

export async function fetchCurrentUser() {
  try {
    const data = await requestJson('/api/auth/me');
    return data.user;
  } catch {
    return null;
  }
}

export async function getAuthSessions(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  return requestJson(`/api/auth/sessions${query ? `?${query}` : ''}`);
}

export async function getAdminSessions(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  return requestJson(`/api/admin/sessions${query ? `?${query}` : ''}`);
}

export async function getVehicleReports() {
  try {
    return await requestJson('/api/reports');
  } catch {
    return [];
  }
}

export async function saveVehicleReport(report) {
  return requestJson('/api/reports', {
    method: 'POST',
    body: JSON.stringify(report),
  });
}

export async function deleteVehicleReport(vin) {
  return requestJson(`/api/reports/${encodeURIComponent(vin)}`, { method: 'DELETE' });
}

export async function setReportComparisonSelection(vin, selected) {
  return requestJson(`/api/reports/${encodeURIComponent(vin)}/comparison`, {
    method: 'PATCH',
    body: JSON.stringify({ selected }),
  });
}

export async function getAdminAuditLogs(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  return requestJson(`/api/admin/audit-logs${query ? `?${query}` : ''}`);
}

export function buildAdminAuditCsvUrl(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  params.set('format', 'csv');

  return `${apiBaseUrl}/api/admin/audit-logs?${params.toString()}`;
}

export async function getAdminSecurityAlerts(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  return requestJson(`/api/admin/security-alerts${query ? `?${query}` : ''}`);
}

export function buildAdminSecurityAlertsCsvUrl(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  params.set('format', 'csv');

  return `${apiBaseUrl}/api/admin/security-alerts?${params.toString()}`;
}

export async function updateAdminSecurityAlert(id, action, note) {
  return requestJson(`/api/admin/security-alerts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ action, note }),
  });
}

export async function updateAdminSecurityAlertsBulk(ids, action, note) {
  return requestJson('/api/admin/security-alerts/bulk', {
    method: 'PATCH',
    body: JSON.stringify({ ids, action, note }),
  });
}

export async function getAdminAlertDeliveryLogs(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const query = params.toString();
  return requestJson(`/api/admin/alert-delivery-logs${query ? `?${query}` : ''}`);
}

export async function exportMyData() {
  return requestJson('/api/auth/data-export');
}

export async function requestDataDeletion(reason) {
  return requestJson('/api/auth/data-deletion-request', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

