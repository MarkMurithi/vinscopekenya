import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const configuredJwtSecret = process.env.JWT_SECRET?.trim();
const fallbackJwtSecret = process.env.NODE_ENV === 'production'
  ? crypto.randomBytes(32).toString('hex')
  : 'dev-insecure-secret-change-me';
const JWT_SECRET = configuredJwtSecret || fallbackJwtSecret;
const TOKEN_EXPIRY = '7d';
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_COOKIE_NAME = 'vinscope_token';
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: TOKEN_MAX_AGE_MS,
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME);
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  const payload = token && verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.user = payload;
  next();
}
