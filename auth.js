import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const configuredJwtSecret = process.env.JWT_SECRET?.trim();
if (process.env.NODE_ENV === 'production' && !configuredJwtSecret) {
  throw new Error('JWT_SECRET must be set in production.');
}

const fallbackJwtSecret = 'dev-insecure-secret-change-me';
const JWT_SECRET = configuredJwtSecret || fallbackJwtSecret;
const ACCESS_TOKEN_TTL_MINUTES = Number(process.env.ACCESS_TOKEN_TTL_MINUTES || 15);
const ACCESS_TOKEN_MAX_AGE_MS = Math.max(1, ACCESS_TOKEN_TTL_MINUTES) * 60 * 1000;
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_TTL || `${Math.max(1, ACCESS_TOKEN_TTL_MINUTES)}m`;
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
const REFRESH_TOKEN_MAX_AGE_MS = Math.max(1, REFRESH_TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000;
const JWT_ISSUER = process.env.JWT_ISSUER || 'vinscope-kenya-api';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'vinscope-kenya-app';
const allowedSameSiteValues = new Set(['strict', 'lax', 'none']);
const configuredSameSite = String(process.env.AUTH_COOKIE_SAME_SITE || 'strict').trim().toLowerCase();
if (!allowedSameSiteValues.has(configuredSameSite)) {
  throw new Error('AUTH_COOKIE_SAME_SITE must be one of: strict, lax, none.');
}
if (process.env.NODE_ENV === 'production' && configuredSameSite === 'none') {
  throw new Error('AUTH_COOKIE_SAME_SITE=none is not allowed in production. Use strict or lax.');
}
if (process.env.NODE_ENV === 'production' && String(process.env.AUTH_COOKIE_SECURE || '').trim().toLowerCase() === 'false') {
  throw new Error('AUTH_COOKIE_SECURE cannot be false in production.');
}

const AUTH_COOKIE_SAME_SITE = configuredSameSite;
const AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const AUTH_COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;
let sessionVersionResolver = null;
export const ACCESS_COOKIE_NAME = 'vinscope_access_token';
export const REFRESH_COOKIE_NAME = 'vinscope_refresh_token';
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const AUTH_COOKIE_POLICY = {
  secure: AUTH_COOKIE_SECURE,
  httpOnly: true,
  sameSite: AUTH_COOKIE_SAME_SITE,
  domain: AUTH_COOKIE_DOMAIN,
};

export function setSessionVersionResolver(resolver) {
  sessionVersionResolver = resolver;
}

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid: crypto.randomUUID(),
    subject: String(payload.id),
  });
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch {
    return null;
  }
}

const sharedCookieOptions = {
  httpOnly: true,
  secure: AUTH_COOKIE_SECURE,
  sameSite: AUTH_COOKIE_SAME_SITE,
  domain: AUTH_COOKIE_DOMAIN,
  path: '/',
};

export function createRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

export function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function setAccessTokenCookie(res, token) {
  res.cookie(ACCESS_COOKIE_NAME, token, {
    ...sharedCookieOptions,
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  });
}

export function setRefreshTokenCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...sharedCookieOptions,
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE_NAME, sharedCookieOptions);
  res.clearCookie(REFRESH_COOKIE_NAME, sharedCookieOptions);
}

export function getRefreshTokenExpiryDate() {
  return new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS);
}

export function setAuthCookies(res, accessToken, refreshToken) {
  setAccessTokenCookie(res, accessToken);
  setRefreshTokenCookie(res, refreshToken);
}

export function clearAccessTokenCookie(res) {
  res.clearCookie(ACCESS_COOKIE_NAME, sharedCookieOptions);
}

export function setLegacyAuthCookie() {
  throw new Error('setLegacyAuthCookie is no longer supported. Use setAuthCookies instead.');
}

export function clearLegacyAuthCookie() {
  throw new Error('clearLegacyAuthCookie is no longer supported. Use clearAuthCookies instead.');
}

export function setAuthCookie(res, token) {
  res.cookie(ACCESS_COOKIE_NAME, token, {
    httpOnly: true,
    secure: AUTH_COOKIE_SECURE,
    sameSite: AUTH_COOKIE_SAME_SITE,
    domain: AUTH_COOKIE_DOMAIN,
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  });
}

export function clearAuthCookie(res) {
  clearAuthCookies(res);
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[ACCESS_COOKIE_NAME];
  const payload = token && verifyAccessToken(token);

  if (!payload) {
    return res.status(401).json({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        requestId: req.requestId || null,
      },
    });
  }

  Promise.resolve()
    .then(async () => {
      if (typeof sessionVersionResolver === 'function') {
        const currentSessionVersion = await sessionVersionResolver(payload.id);
        const tokenSessionVersion = Number(payload.sessionVersion ?? 0);

        if (currentSessionVersion !== null && tokenSessionVersion !== Number(currentSessionVersion)) {
          clearAuthCookies(res);
          return res.status(401).json({
            error: {
              code: 'SESSION_REVOKED',
              message: 'Your session is no longer valid. Please sign in again.',
              requestId: req.requestId || null,
            },
          });
        }
      }

      req.user = payload;
      next();
    })
    .catch(next);
}
