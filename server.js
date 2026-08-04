import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { isValidVinFormat, decodeVinWithNhtsa, mapNhtsaResultToVehicle } from './vinDecoder.js';

const { Pool } = pkg;
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(distDir));

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/vinscope';
const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const seedVehicles = [
  {
    vin: 'JTEBU5JR3K5001234',
    make: 'Toyota',
    model: 'Prado',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Consistent',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'WVWZZZ1JZ3W123456',
    make: 'Volkswagen',
    model: 'Golf',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Consistent',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 91,
    source: 'postgres-seed',
  },
  {
    vin: '1HGCM82633A004352',
    make: 'Honda',
    model: 'Accord',
    year: 2003,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Inconsistent',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 57,
    source: 'postgres-seed',
  },
];

const initializeDatabase = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      vin VARCHAR(30) UNIQUE NOT NULL,
      make VARCHAR(100) NOT NULL,
      model VARCHAR(100) NOT NULL,
      year INTEGER,
      status VARCHAR(50) NOT NULL,
      theft VARCHAR(150) NOT NULL,
      ownership VARCHAR(150) NOT NULL,
      accidents VARCHAR(150) NOT NULL,
      mileage VARCHAR(150) NOT NULL,
      score INTEGER,
      source VARCHAR(100) NOT NULL DEFAULT 'postgres',
      manufacturer VARCHAR(150),
      plant_country VARCHAR(100),
      body_class VARCHAR(100),
      vehicle_type VARCHAR(100),
      fuel_type VARCHAR(100),
      engine_cylinders VARCHAR(20),
      displacement_l VARCHAR(20),
      history_available BOOLEAN NOT NULL DEFAULT true
    );
  `);

  // Relax/extend constraints for tables created before real-VIN (NHTSA) support was added.
  await pool.query('ALTER TABLE vehicles ALTER COLUMN year DROP NOT NULL;');
  await pool.query('ALTER TABLE vehicles ALTER COLUMN score DROP NOT NULL;');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(150);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS plant_country VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS body_class VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS engine_cylinders VARCHAR(20);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS displacement_l VARCHAR(20);');
  await pool.query("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS history_available BOOLEAN NOT NULL DEFAULT true;");

  for (const vehicle of seedVehicles) {
    await pool.query(
      `
        INSERT INTO vehicles (vin, make, model, year, status, theft, ownership, accidents, mileage, score, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (vin) DO NOTHING
      `,
      [vehicle.vin, vehicle.make, vehicle.model, vehicle.year, vehicle.status, vehicle.theft, vehicle.ownership, vehicle.accidents, vehicle.mileage, vehicle.score, vehicle.source]
    );
  }
};

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'vinscope-vehicle-api', database: 'postgres' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const VEHICLE_COLUMNS = `
  vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
  manufacturer, plant_country AS "plantCountry", body_class AS "bodyClass",
  vehicle_type AS "vehicleType", fuel_type AS "fuelType", engine_cylinders AS "engineCylinders",
  displacement_l AS "displacementL", history_available AS "historyAvailable"
`;

async function upsertVehicle(vehicle) {
  const {
    vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
    manufacturer = null, plantCountry = null, bodyClass = null, vehicleType = null,
    fuelType = null, engineCylinders = null, displacementL = null, historyAvailable = true,
  } = vehicle;

  const { rows } = await pool.query(
    `
      INSERT INTO vehicles (
        vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
        manufacturer, plant_country, body_class, vehicle_type, fuel_type, engine_cylinders, displacement_l, history_available
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (vin) DO UPDATE SET
        make = EXCLUDED.make,
        model = EXCLUDED.model,
        year = EXCLUDED.year,
        status = EXCLUDED.status,
        theft = EXCLUDED.theft,
        ownership = EXCLUDED.ownership,
        accidents = EXCLUDED.accidents,
        mileage = EXCLUDED.mileage,
        score = EXCLUDED.score,
        source = EXCLUDED.source,
        manufacturer = EXCLUDED.manufacturer,
        plant_country = EXCLUDED.plant_country,
        body_class = EXCLUDED.body_class,
        vehicle_type = EXCLUDED.vehicle_type,
        fuel_type = EXCLUDED.fuel_type,
        engine_cylinders = EXCLUDED.engine_cylinders,
        displacement_l = EXCLUDED.displacement_l,
        history_available = EXCLUDED.history_available
      RETURNING ${VEHICLE_COLUMNS}
    `,
    [
      vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
      manufacturer, plantCountry, bodyClass, vehicleType, fuelType, engineCylinders, displacementL, historyAvailable,
    ]
  );

  return rows[0];
}

app.get('/api/vehicles/:vin', async (req, res) => {
  const vin = req.params.vin.trim().toUpperCase();

  if (!isValidVinFormat(vin)) {
    return res.status(400).json({
      error: 'Invalid VIN format. A VIN is 17 characters (letters and numbers, excluding I, O, Q).',
      vin,
    });
  }

  const { rows } = await pool.query(`SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE vin = $1`, [vin]);

  if (rows[0]) {
    return res.json(rows[0]);
  }

  // Not in our database - fall back to the free, public NHTSA vPIC decoder for a real VIN decode.
  // This works for VINs from any country (Kenya, Japan, etc.) since VIN structure is a global
  // ISO 3779 standard, but it cannot provide accident/theft/ownership history (no such free
  // public source exists), which is reflected via historyAvailable: false.
  const decoded = await decodeVinWithNhtsa(vin);
  if (!decoded) {
    return res.status(404).json({ error: 'Vehicle not found', vin });
  }

  const mapped = mapNhtsaResultToVehicle(vin, decoded);
  const cached = await upsertVehicle(mapped);
  return res.json(cached);
});

app.post('/api/vehicles', async (req, res) => {
  const vehicle = req.body;
  if (!vehicle?.vin) {
    return res.status(400).json({ error: 'VIN is required' });
  }

  const saved = await upsertVehicle({
    ...vehicle,
    vin: vehicle.vin.toUpperCase(),
    source: vehicle.source || 'postgres',
  });

  return res.status(201).json(saved);
});

app.get(/^(?!\/api|\/health).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const port = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'test') {
  initializeDatabase()
    .then(() => {
      app.listen(port, () => {
        console.log(`Vehicle API listening on port ${port}`);
      });
    })
    .catch((error) => {
      console.error('Database initialization failed', error);
      process.exit(1);
    });
}

export { app, pool };
