import { createHmac, timingSafeEqual } from 'node:crypto'
import { env, isRazorpayConfigured } from '../config/env.js'
import { ApiError } from '../utils/api-error.js'

const apiBase = 'https://api.razorpay.com/v1'

const safeEqualHex = (expected: string, actual: string) => {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Checkout signature: HMAC-SHA256(`${order_id}|${payment_id}`, key_secret). */
export const verifyPaymentSignature = (razorpayOrderId: string, razorpayPaymentId: string, signature: string) => {
  if (!env.RAZORPAY_KEY_SECRET) return false
  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex')
  return safeEqualHex(expected, signature)
}

/** Webhook signature: HMAC-SHA256 of the exact raw request body with the webhook secret. */
export const verifyWebhookSignature = (rawBody: Buffer, signature: string) => {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')
  return safeEqualHex(expected, signature)
}

/** Converts rupees to the integer paise amount Razorpay expects. */
export const toPaise = (rupees: number) => Math.round(rupees * 100)

type RazorpayOrder = { id: string; amount: number; currency: string; status: 'created' | 'attempted' | 'paid'; receipt?: string }

const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  if (!isRazorpayConfigured) throw new ApiError(503, 'Online payments are not available right now', [], 'PAYMENTS_UNAVAILABLE')
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    // The provider's error body is not forwarded to clients.
    throw new ApiError(502, 'Payment provider request failed', [], 'PAYMENT_PROVIDER_ERROR')
  }
  return response.json() as Promise<T>
}

/** Overridable for tests so no real provider calls are made. */
export const razorpayClient = {
  createOrder: (input: { amountPaise: number; currency: string; receipt: string; notes: Record<string, string> }) =>
    call<RazorpayOrder>('/orders', { method: 'POST', body: JSON.stringify({ amount: input.amountPaise, currency: input.currency, receipt: input.receipt, notes: input.notes }) }),
  fetchOrder: (razorpayOrderId: string) => call<RazorpayOrder>(`/orders/${encodeURIComponent(razorpayOrderId)}`),
  fetchOrderPayments: (razorpayOrderId: string) => call<{ items: Array<{ id: string; status: string }> }>(`/orders/${encodeURIComponent(razorpayOrderId)}/payments`),
}
