# Vinscope Kenya

A vehicle-history web app prototype with a PostgreSQL-backed backend.

## Run locally

1. Start PostgreSQL locally with Docker:
   ```bash
   docker-compose up -d
   ```
2. Copy the example environment file:
   ```bash
   copy .env.example .env
   ```
   Keep `LOCAL_DATABASE_URL` and `TEST_DATABASE_URL` pointed at local Postgres.
   The server now refuses remote database hosts in `development` and `test` by default.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the backend:
   ```bash
   node server.js
   ```
5. Start the frontend:
   ```bash
   npm run dev
   ```
6. Open the frontend at http://localhost:5173/

## Deploy to Render

1. Create a new Render Web Service from this repository.
2. Render will read [render.yaml](render.yaml).
3. Connect the managed PostgreSQL database created by Render to the service automatically.
4. Deploy the service.

## API

- GET /health
- GET /api/vehicles/:vin
- POST /api/vehicles (requires auth)
- POST /api/auth/register, POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me
- GET /api/reports, POST /api/reports, DELETE /api/reports/:vin (all require auth)
- POST /api/payments/stkpush, POST /api/payments/mpesa/callback, GET /api/payments/status/:checkoutRequestId
- GET /api/admin/health/mpesa (requires auth)

## Required environment variables

See [.env.example](.env.example). At minimum, set `DATABASE_URL` and a strong `JWT_SECRET`.
M-Pesa payments (`MPESA_*` vars) are optional - without them, `/api/payments/stkpush` returns a
clear "not configured" error instead of failing unpredictably.

## Postman STK Push checklist (Sandbox)

Use the Safaricom Postman collection to verify the payment path end-to-end.

1. Start PostgreSQL and backend, then confirm `GET /health` returns OK.
2. Confirm local env values are set in `.env`:
   - `MPESA_ENV=sandbox`
   - `MPESA_CONSUMER_KEY`
   - `MPESA_CONSUMER_SECRET`
   - `MPESA_SHORTCODE=174379`
   - `MPESA_PASSKEY`
   - `PUBLIC_BASE_URL` is public HTTPS and reachable by Safaricom callback.
3. In Postman, run OAuth token request:
   - `GET https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials`
4. Initiate STK Push:
   - `POST https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest`
   - Required request fields:
     - `BusinessShortCode` = `174379`
     - `TransactionType` = `CustomerPayBillOnline`
     - `PhoneNumber` and `PartyA` in `2547XXXXXXXX` format
     - `PartyB` = shortcode
     - `Amount` > `0`
     - `CallBackURL` = `<PUBLIC_BASE_URL>/api/payments/mpesa/callback`
5. Approve the STK prompt on phone.
6. Validate callback delivery and saved status:
   - Backend logs show callback hit on `/api/payments/mpesa/callback`.
   - App status endpoint shows completed state:
     - `GET /api/payments/status/:checkoutRequestId`

If callback does not arrive in local development, set `PUBLIC_BASE_URL` to a public HTTPS tunnel URL and retry.

## Tests & CI

Run `npm test` against a local PostgreSQL instance (see `docker-compose up -d`). GitHub Actions
(`.github/workflows/ci.yml`) runs the test suite and build against a fresh Postgres service
container on every push/PR to `main`.

### Database safety guardrails

- `production`: requires `DATABASE_URL`.
- `development`: uses `LOCAL_DATABASE_URL` (fallback: `DATABASE_URL`, then local default) and refuses non-local hosts unless `ALLOW_EXTERNAL_DATABASE_IN_DEV=true`.
- `test`: uses `TEST_DATABASE_URL` (fallback: `LOCAL_DATABASE_URL`, then `DATABASE_URL`, then local default) and refuses non-local hosts unless `ALLOW_EXTERNAL_DATABASE_IN_TEST=true`.

This is designed to prevent accidental writes from local development/test runs to production databases.

## Auth/session hardening

- Production now requires `JWT_SECRET` to be set explicitly.
- Access tokens are now short-lived and default to 15 minutes (`ACCESS_TOKEN_TTL` / `ACCESS_TOKEN_TTL_MINUTES`).
- Refresh tokens are stored server-side, rotated on use, and default to 30 days (`REFRESH_TOKEN_TTL_DAYS`).
- Refresh sessions also expire after inactivity (`REFRESH_SESSION_IDLE_MINUTES`), which forces re-authentication even if the refresh token has not yet reached its absolute expiry.
- Auth cookies default to `httpOnly` + `SameSite=Strict`.
- In production, cookies are enforced as `secure=true` and `sameSite` must be `strict` or `lax`.
- JWTs now include issuer/audience validation (`JWT_ISSUER`, `JWT_AUDIENCE`).
- Password login is temporarily locked after repeated failed attempts (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`).
- Repeated failed password attempts are also rate-limited per IP/network (`LOGIN_IP_MAX_FAILURES`, `LOGIN_IP_WINDOW_MINUTES`, `LOGIN_IP_LOCKOUT_MINUTES`).
- OTP issuance and verification are additionally throttled per phone and per IP (`OTP_SEND_*`, `OTP_VERIFY_*`) to reduce abuse.
- Admin-only audit log viewing is available at `GET /api/admin/audit-logs` and can be filtered by `userId`, `email`, `eventType`, `from`, `to`, and `limit`.
- Admin-only security alert viewing is available at `GET /api/admin/security-alerts` and can be filtered by `alertType`, `severity`, `subject`, `from`, `to`, `limit`, and `offset`.
- Admin users can be designated via the `ADMIN_EMAILS` environment variable or by setting `users.is_admin = true` directly.
- Automatic security alerts are generated from auth audit events when repeated lockouts or refresh-token reuse cross configured thresholds (`AUTH_ALERT_WINDOW_MINUTES`, `LOCKOUT_ALERT_THRESHOLD`, `REFRESH_REUSE_ALERT_THRESHOLD`).
- Alert severities currently map to `warning` for repeated lockouts and `critical` for refresh-token reuse.
- Optional outbound alert hooks can be configured for generic webhooks (`AUTH_ALERT_WEBHOOK_URL`), Slack (`AUTH_ALERT_SLACK_WEBHOOK_URL`), and email via Resend (`AUTH_ALERT_EMAIL_FROM`, `AUTH_ALERT_EMAIL_TO`, `RESEND_API_KEY`).
- Suspicious activity such as refresh-token reuse or revoked/idle-expired sessions now triggers forced logout in the frontend so stale sessions are cleared immediately.

## Error reporting

- Backend request crashes and process-level fatal errors are now written into the `app_error_events` table.
- Frontend render/browser crashes are reported to `POST /api/client-errors` and stored in the same table.
- This provides a database-backed error sink instead of relying only on console output.

## Legal review workflow

- Final legal approval must be completed by qualified counsel before production launch.
- Use [LEGAL_REVIEW_PACKET.md](LEGAL_REVIEW_PACKET.md) as the counsel handoff checklist and sign-off record.
