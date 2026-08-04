// Safaricom Daraja (M-Pesa) STK Push integration.
//
// Requires the following environment variables to be set (see .env.example):
//   MPESA_ENV              'sandbox' (default) or 'production'
//   MPESA_CONSUMER_KEY     Daraja app consumer key
//   MPESA_CONSUMER_SECRET  Daraja app consumer secret
//   MPESA_SHORTCODE        Paybill/till (Business Short Code)
//   MPESA_PASSKEY          Lipa Na M-Pesa Online passkey for the shortcode
//   PUBLIC_BASE_URL        Public HTTPS URL of this server, used for the callback
//
// Without these set, isMpesaConfigured() returns false and the API responds
// with a clear "M-Pesa is not configured" error instead of guessing credentials.

function baseUrl() {
  return process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

export function isMpesaConfigured() {
  return Boolean(
    process.env.MPESA_CONSUMER_KEY &&
      process.env.MPESA_CONSUMER_SECRET &&
      process.env.MPESA_SHORTCODE &&
      process.env.MPESA_PASSKEY
  );
}

async function getAccessToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');

  const response = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain M-Pesa access token (${response.status})`);
  }

  const data = await response.json();
  return data.access_token;
}

function timestampNow() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

// Accepts 07XXXXXXXX, 01XXXXXXXX, 2547XXXXXXXX or +2547XXXXXXXX and normalizes to 2547XXXXXXXX / 2541XXXXXXXX.
export function normalizeKenyanPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');

  if (/^254(7|1)\d{8}$/.test(digits)) return digits;
  if (/^0(7|1)\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^(7|1)\d{8}$/.test(digits)) return `254${digits}`;

  return null;
}

export async function initiateStkPush({ phone, amount, plan, callbackUrl }) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const timestamp = timestampNow();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const accessToken = await getAccessToken();

  const response = await fetch(`${baseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: 'VinscopeKenya',
      TransactionDesc: `Vinscope Kenya ${plan} subscription`,
    }),
  });

  const data = await response.json();

  if (!response.ok || data.errorCode) {
    const message = data.errorMessage || data.ResponseDescription || 'STK push request failed';
    throw new Error(message);
  }

  return data; // { MerchantRequestID, CheckoutRequestID, ResponseCode, ResponseDescription, CustomerMessage }
}

// Parses the callback body Safaricom posts to CallBackURL after the customer
// enters (or cancels) their M-Pesa PIN.
export function parseStkCallback(body) {
  const callback = body?.Body?.stkCallback;
  if (!callback) return null;

  const result = {
    merchantRequestId: callback.MerchantRequestID,
    checkoutRequestId: callback.CheckoutRequestID,
    resultCode: callback.ResultCode,
    resultDesc: callback.ResultDesc,
    success: callback.ResultCode === 0,
    amount: null,
    mpesaReceipt: null,
    phoneNumber: null,
  };

  const items = callback.CallbackMetadata?.Item || [];
  for (const item of items) {
    if (item.Name === 'Amount') result.amount = item.Value;
    if (item.Name === 'MpesaReceiptNumber') result.mpesaReceipt = item.Value;
    if (item.Name === 'PhoneNumber') result.phoneNumber = item.Value;
  }

  return result;
}
