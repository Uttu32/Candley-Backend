import { createHash } from 'node:crypto'
import express, { Router } from 'express'
import { logger } from '../config/logger.js'
import { PaymentEvent } from '../models/PaymentEvent.js'
import { Order } from '../models/Order.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { verifyWebhookSignature } from '../services/razorpay.service.js'
import { markOrderPaid, markPaymentFailed } from '../services/order.service.js'

type WebhookPayload = {
  event?: string
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; status?: string; error_description?: string } }
    order?: { entity?: { id?: string } }
  }
}

export const paymentsRouter = Router()

/**
 * Razorpay webhook. Mounted before the JSON body parser so the signature is checked against the exact raw body.
 * Each event id is processed once; duplicates are acknowledged without side effects.
 */
paymentsRouter.post('/razorpay/webhook', express.raw({ type: 'application/json', limit: '1mb' }), asyncHandler(async (request, response) => {
  const signature = request.get('X-Razorpay-Signature')
  const rawBody = request.body
  if (!Buffer.isBuffer(rawBody) || !signature || !verifyWebhookSignature(rawBody, signature)) {
    throw new ApiError(400, 'Invalid webhook signature', [], 'INVALID_SIGNATURE')
  }

  let payload: WebhookPayload
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload
  } catch {
    throw new ApiError(400, 'Invalid webhook payload', [], 'INVALID_JSON')
  }

  const event = payload.event ?? 'unknown'
  const payment = payload.payload?.payment?.entity
  const razorpayOrderId = payment?.order_id ?? payload.payload?.order?.entity?.id
  // Razorpay sends a unique id per event; fall back to a body hash so retries of the same body still dedupe.
  const eventId = request.get('X-Razorpay-Event-Id') ?? createHash('sha256').update(rawBody).digest('hex')

  try {
    await PaymentEvent.create({ eventId, event, razorpayOrderId, razorpayPaymentId: payment?.id })
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      sendSuccess(response, { duplicate: true }, 'Event already processed')
      return
    }
    throw error
  }

  try {
    let outcome = 'ignored'
    if (razorpayOrderId && (event === 'payment.captured' || event === 'order.paid') && payment?.id) {
      const { changed } = await markOrderPaid(razorpayOrderId, payment.id)
      outcome = changed ? 'marked_paid' : 'already_paid'
    } else if (razorpayOrderId && event === 'payment.failed') {
      outcome = (await markPaymentFailed(razorpayOrderId, payment?.error_description)) ? 'marked_failed' : 'no_change'
    }
    const order = razorpayOrderId ? await Order.findOne({ 'payment.razorpayOrderId': razorpayOrderId }).select('_id').lean() : null
    await PaymentEvent.updateOne({ eventId }, { $set: { outcome, orderId: order?._id } })
    sendSuccess(response, { outcome }, 'Webhook processed')
  } catch (error) {
    // Forget the event so Razorpay's retry is processed rather than treated as a duplicate.
    await PaymentEvent.deleteOne({ eventId })
    if (error instanceof ApiError && error.statusCode === 404) {
      logger.warn({ event, razorpayOrderId }, 'Webhook for unknown order')
      sendSuccess(response, { outcome: 'unknown_order' }, 'Webhook acknowledged')
      return
    }
    throw error
  }
}))
