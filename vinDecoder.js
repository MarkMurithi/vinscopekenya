// Real-world VIN support backed by the free, public NHTSA vPIC API.
// vPIC decodes the VIN structure itself (make/model/year/manufacturer/plant/body/engine)
// using the ISO 3779 standard that VINs follow worldwide. It does NOT provide accident,
// theft, ownership, or mileage history for any country (no free public source exists for
// Kenya/NTSA or Japan/MLIT vehicle history) - that is reflected via `historyAvailable: false`.
const NHTSA_DECODE_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';
const NHTSA_TIMEOUT_MS = 8000;

// VIN charset excludes I, O, Q to avoid confusion with 1, 0 (ISO 3779 / SAE J853).
const VIN_FORMAT_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;

export function isValidVinFormat(vin) {
  return typeof vin === 'string' && VIN_FORMAT_REGEX.test(vin);
}

export async function decodeVinWithNhtsa(vin) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NHTSA_TIMEOUT_MS);

  try {
    const response = await fetch(`${NHTSA_DECODE_URL}/${encodeURIComponent(vin)}?format=json`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const result = payload?.Results?.[0];

    if (!result || !result.Make) {
      return null;
    }

    return result;
  } catch (error) {
    console.error('NHTSA vPIC lookup failed:', error.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function mapNhtsaResultToVehicle(vin, result) {
  return {
    vin,
    make: result.Make || 'Unknown',
    model: result.Model || 'Unknown',
    year: result.ModelYear ? Number(result.ModelYear) : null,
    status: 'Decoded (no history record)',
    theft: 'No public theft record on file',
    ownership: 'No public ownership record on file',
    accidents: 'No public accident record on file',
    mileage: 'No public odometer record on file',
    score: null,
    source: 'nhtsa-vpic',
    manufacturer: result.Manufacturer || null,
    plantCountry: result.PlantCountry || null,
    bodyClass: result.BodyClass || null,
    vehicleType: result.VehicleType || null,
    fuelType: result.FuelTypePrimary || null,
    engineCylinders: result.EngineCylinders || null,
    displacementL: result.DisplacementL || null,
    historyAvailable: false,
  };
}
