import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';

const { Pool } = pkg;
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/vinscope',
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
      year INTEGER NOT NULL,
      status VARCHAR(50) NOT NULL,
      theft VARCHAR(100) NOT NULL,
      ownership VARCHAR(100) NOT NULL,
      accidents VARCHAR(150) NOT NULL,
      mileage VARCHAR(150) NOT NULL,
      score INTEGER NOT NULL,
      source VARCHAR(100) NOT NULL DEFAULT 'postgres'
    );
  `);

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

app.get('/api/vehicles/:vin', async (req, res) => {
  const vin = req.params.vin.trim().toUpperCase();
  const { rows } = await pool.query(
    `SELECT vin, make, model, year, status, theft, ownership, accidents, mileage, score, source FROM vehicles WHERE vin = $1`,
    [vin]
  );

  const vehicle = rows[0];
  if (!vehicle) {
    return res.status(404).json({ error: 'Vehicle not found', vin });
  }

  return res.json(vehicle);
});

app.post('/api/vehicles', async (req, res) => {
  const vehicle = req.body;
  if (!vehicle?.vin) {
    return res.status(400).json({ error: 'VIN is required' });
  }

  const normalizedVehicle = {
    ...vehicle,
    vin: vehicle.vin.toUpperCase(),
    source: 'postgres',
  };

  const { rows } = await pool.query(
    `
      INSERT INTO vehicles (vin, make, model, year, status, theft, ownership, accidents, mileage, score, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        source = EXCLUDED.source
      RETURNING vin, make, model, year, status, theft, ownership, accidents, mileage, score, source
    `,
    [normalizedVehicle.vin, normalizedVehicle.make, normalizedVehicle.model, normalizedVehicle.year, normalizedVehicle.status, normalizedVehicle.theft, normalizedVehicle.ownership, normalizedVehicle.accidents, normalizedVehicle.mileage, normalizedVehicle.score, normalizedVehicle.source]
  );

  return res.status(201).json(rows[0]);
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
