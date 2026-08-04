import { requestJson } from './vehicleApi';

export async function startMpesaPayment(plan, phone) {
  return requestJson('/api/payments/stkpush', {
    method: 'POST',
    body: JSON.stringify({ plan, phone }),
  });
}

export async function getPaymentStatus(checkoutRequestId) {
  return requestJson(`/api/payments/status/${encodeURIComponent(checkoutRequestId)}`);
}
