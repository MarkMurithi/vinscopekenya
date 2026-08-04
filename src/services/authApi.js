import { requestJson } from './vehicleApi';

// Real, server-backed auth against Postgres (bcrypt-hashed passwords + an httpOnly JWT cookie).
// Replaces the old localStorage-based mockApi.js.

export async function registerUser(email, password, name) {
  try {
    const data = await requestJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
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

export async function fetchCurrentUser() {
  try {
    const data = await requestJson('/api/auth/me');
    return data.user;
  } catch {
    return null;
  }
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
