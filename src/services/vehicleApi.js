const DEFAULT_BASE_URL = import.meta.env.DEV ? 'http://localhost:5000' : '';
const baseUrl = import.meta.env.VITE_VEHICLE_API_URL || DEFAULT_BASE_URL;

export async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message = data?.error || response.statusText || 'Request failed';
    const error = new Error(message);
    error.status = response.status;
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
