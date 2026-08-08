import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const email = String(process.env.VIN_ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.VIN_ADMIN_PASSWORD || '');
const confirmation = String(process.env.VIN_CONFIRM_ACCOUNT_RESET || '');
if (!email || password.length < 8) {
  throw new Error('VIN_ADMIN_EMAIL and a VIN_ADMIN_PASSWORD of at least 8 characters are required');
}
if (confirmation !== 'DELETE ALL ACCOUNTS') {
  throw new Error('VIN_CONFIRM_ACCOUNT_RESET must be exactly: DELETE ALL ACCOUNTS');
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const hostname = new URL(connectionString).hostname.toLowerCase();
const localHosts = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal']);
const pool = new pg.Pool({
  connectionString,
  ssl: localHosts.has(hostname) ? false : { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const deleted = await client.query('DELETE FROM users');
  await client.query('DELETE FROM otp_codes');
  await client.query('DELETE FROM auth_abuse_buckets');

  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await client.query(
    `INSERT INTO users (
       email, password_hash, name, is_verified, verification_method,
       is_admin, session_version, failed_login_attempts, locked_until
     )
     VALUES ($1, $2, $3, true, 'email', true, 0, 0, NULL)
     RETURNING id, email, name, is_admin, is_verified, failed_login_attempts, locked_until`,
    [email, passwordHash, 'Mark Murithi'],
  );
  await client.query('COMMIT');

  const result = {
    deletedAccounts: deleted.rowCount,
    totalAccounts: 1,
    admin: rows[0],
  };
  console.log(JSON.stringify(result));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}