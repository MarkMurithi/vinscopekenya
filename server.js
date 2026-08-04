import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { isValidVinFormat, decodeVinWithNhtsa, mapNhtsaResultToVehicle } from './vinDecoder.js';
import {
  EMAIL_REGEX,
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
} from './auth.js';
import { isMpesaConfigured, normalizeKenyanPhone, initiateStkPush, parseStkCallback } from './mpesa.js';

const { Pool } = pkg;
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

// In production the frontend is served from this same Express app, so no CORS is
// needed by default. Set ALLOWED_ORIGIN if the frontend is ever hosted separately
// (e.g. during local dev, the Vite dev server on http://localhost:5173).
const allowedOrigin = process.env.ALLOWED_ORIGIN || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigin === false ? true : allowedOrigin, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(distDir));

// General API rate limit, plus a stricter limit on auth/payment endpoints to reduce brute force / abuse.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});
app.use('/api', apiLimiter);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(150) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_reports (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vin VARCHAR(30) NOT NULL,
      make VARCHAR(100),
      model VARCHAR(100),
      year INTEGER,
      status VARCHAR(50),
      theft VARCHAR(150),
      ownership VARCHAR(150),
      accidents VARCHAR(150),
      mileage VARCHAR(150),
      score INTEGER,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      selected_for_comparison BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (user_id, vin)
    );
  `);

  await pool.query('ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS selected_for_comparison BOOLEAN NOT NULL DEFAULT false;');


  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan VARCHAR(50) NOT NULL,
      amount INTEGER NOT NULL,
      phone VARCHAR(20) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      checkout_request_id VARCHAR(100) UNIQUE,
      mpesa_receipt VARCHAR(100),
      result_desc VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

// Requires an authenticated user so only logged-in users can create/overwrite vehicle records.
app.post('/api/vehicles', requireAuth, async (req, res) => {
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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [normalizedEmail, passwordHash, (name || '').trim() || 'Vinscope User']
    );

    const user = rows[0];
    setAuthCookie(res, signToken({ id: user.id, email: user.email }));
    return res.status(201).json({ user });
  } catch (error) {
    console.error('Registration failed', error);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );
    const user = rows[0];
    const valid = user && (await verifyPassword(password, user.password_hash));

    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    setAuthCookie(res, signToken({ id: user.id, email: user.email }));
    return res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    console.error('Login failed', error);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user: rows[0] });
});

// ---------------------------------------------------------------------------
// Saved reports (per authenticated user)
// ---------------------------------------------------------------------------

const REPORT_COLUMNS = `vin, make, model, year, status, theft, ownership, accidents, mileage, score, saved_at AS "savedAt", selected_for_comparison AS "selectedForComparison"`;

app.get('/api/reports', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${REPORT_COLUMNS} FROM saved_reports WHERE user_id = $1 ORDER BY saved_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

app.post('/api/reports', requireAuth, async (req, res) => {
  const report = req.body || {};
  if (!report.vin) {
    return res.status(400).json({ error: 'VIN is required' });
  }

  const { rows } = await pool.query(
    `
      INSERT INTO saved_reports (user_id, vin, make, model, year, status, theft, ownership, accidents, mileage, score)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (user_id, vin) DO UPDATE SET
        make = EXCLUDED.make, model = EXCLUDED.model, year = EXCLUDED.year, status = EXCLUDED.status,
        theft = EXCLUDED.theft, ownership = EXCLUDED.ownership, accidents = EXCLUDED.accidents,
        mileage = EXCLUDED.mileage, score = EXCLUDED.score, saved_at = now()
      RETURNING ${REPORT_COLUMNS}
    `,
    [
      req.user.id,
      String(report.vin).toUpperCase(),
      report.make || null,
      report.model || null,
      report.year || null,
      report.status || null,
      report.theft || null,
      report.ownership || null,
      report.accidents || null,
      report.mileage || null,
      report.score ?? null,
    ]
  );

  res.status(201).json(rows[0]);
});

app.delete('/api/reports/:vin', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM saved_reports WHERE user_id = $1 AND vin = $2', [
    req.user.id,
    req.params.vin.toUpperCase(),
  ]);
  res.json({ ok: true });
});

app.patch('/api/reports/:vin/comparison', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE saved_reports SET selected_for_comparison = $1 WHERE user_id = $2 AND vin = $3 RETURNING ${REPORT_COLUMNS}`,
    [Boolean(req.body?.selected), req.user.id, req.params.vin.toUpperCase()]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: 'Saved report not found' });
  }

  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// M-Pesa payments (Daraja STK Push)
// ---------------------------------------------------------------------------

const PLAN_AMOUNTS = { Starter: 0, Pro: 999, Business: 2999 };

app.post('/api/payments/stkpush', requireAuth, async (req, res) => {
  if (!isMpesaConfigured()) {
    return res.status(503).json({
      error: 'M-Pesa is not configured on this server yet. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE and MPESA_PASSKEY.',
    });
  }

  const { plan, phone } = req.body || {};
  const amount = PLAN_AMOUNTS[plan];

  if (!amount) {
    return res.status(400).json({ error: 'Choose a valid plan (Pro or Business)' });
  }

  const normalizedPhone = normalizeKenyanPhone(phone);
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 07XXXXXXXX' });
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const stk = await initiateStkPush({
      phone: normalizedPhone,
      amount,
      plan,
      callbackUrl: `${publicBaseUrl}/api/payments/mpesa/callback`,
    });

    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, amount, phone, status, checkout_request_id)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [req.user.id, plan, amount, normalizedPhone, stk.CheckoutRequestID]
    );

    return res.status(202).json({
      checkoutRequestId: stk.CheckoutRequestID,
      message: stk.CustomerMessage || 'Enter your M-Pesa PIN on your phone to complete payment.',
    });
  } catch (error) {
    console.error('STK push failed', error);
    return res.status(502).json({ error: error.message || 'Could not start M-Pesa payment' });
  }
});

// Public endpoint - called by Safaricom's servers, not the browser.
app.post('/api/payments/mpesa/callback', async (req, res) => {
  const result = parseStkCallback(req.body);

  if (result) {
    await pool.query(
      `UPDATE subscriptions
       SET status = $1, mpesa_receipt = $2, result_desc = $3, updated_at = now()
       WHERE checkout_request_id = $4`,
      [result.success ? 'completed' : 'failed', result.mpesaReceipt, result.resultDesc, result.checkoutRequestId]
    );
  }

  // Safaricom expects a 200 response acknowledging receipt of the callback.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/api/payments/status/:checkoutRequestId', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT status, plan, mpesa_receipt AS "mpesaReceipt" FROM subscriptions WHERE checkout_request_id = $1 AND user_id = $2',
    [req.params.checkoutRequestId, req.user.id]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  res.json(rows[0]);
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

export { app, pool, initializeDatabase };
