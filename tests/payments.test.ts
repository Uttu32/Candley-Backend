import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Cart } from '../src/models/Cart.js'
import { Order } from '../src/models/Order.js'
import { PaymentEvent } from '../src/models/PaymentEvent.js'
import { Product } from '../src/models/Product.js'
import { razorpayClient } from '../src/services/razorpay.service.js'
import { expireUnpaidOrders } from '../src/services/order.service.js'
import { address, api, connectTestDb, createProduct, disconnectTestDb, loginAs, resetDb } from './helpers.js'

beforeAll(connectTestDb)
afterAll(disconnectTestDb)
beforeEach(async () => {
  await resetDb()
  // No real provider calls in tests: the Razorpay client is stubbed with sandbox-shaped responses.
  let sequence = 0
  vi.spyOn(razorpayClient, 'createOrder').mockImplementation(async (input) => ({ id: `order_test_${(sequence += 1)}`, amount: input.amountPaise, currency: input.currency, status: 'created', receipt: input.receipt }))
})
afterEach(() => vi.restoreAllMocks())

const keySecret = process.env.RAZORPAY_KEY_SECRET!
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET!
const sign = (orderId: string, paymentId: string) => createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex')

const placeOnlineOrder = async () => {
  const customer = await loginAs()
  const product = await createProduct({ price: 1250, mrp: 1500, stock: 5 })
  await api().post('/api/v1/cart/items').set(customer.auth).send({ productId: product.id, quantity: 2 })
  const order = await api().post('/api/v1/orders').set(customer.auth).send({ shippingAddress: address, paymentMethod: 'RAZORPAY' })
  expect(order.status).toBe(201)
  const payment = await api().post(`/api/v1/orders/${order.body.data._id}/payment/razorpay`).set(customer.auth)
  expect(payment.status).toBe(200)
  return { customer, product, order: order.body.data, payment: payment.body.data }
}

const webhook = (body: Record<string, unknown>, options: { secret?: string; eventId?: string } = {}) => {
  const raw = JSON.stringify(body)
  const signature = createHmac('sha256', options.secret ?? webhookSecret).update(raw).digest('hex')
  return api().post('/api/v1/payments/razorpay/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', signature).set('X-Razorpay-Event-Id', options.eventId ?? 'evt_1').send(raw)
}

const capturedEvent = (razorpayOrderId: string, paymentId = 'pay_123') => ({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: razorpayOrderId, status: 'captured' } } } })

describe('razorpay checkout', () => {
  it('reserves stock, keeps the cart, and creates a provider order from the stored amount in paise', async () => {
    const { customer, product, order, payment } = await placeOnlineOrder()
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', total: 2500 })
    expect(payment).toMatchObject({ amount: 250000, currency: 'INR', keyId: 'rzp_test_dummykey', razorpayOrderId: 'order_test_1' })
    expect(payment).not.toHaveProperty('keySecret')
    expect(JSON.stringify(payment)).not.toContain(keySecret)
    expect((await Product.findById(product.id).lean())!.stock).toBe(3)
    expect((await Cart.findOne({ userId: customer.user.id }).lean())!.items).toHaveLength(1)
  })

  it('reuses the provider order on repeated payment initiation and returns the pending order on resubmission', async () => {
    const { customer, order } = await placeOnlineOrder()
    const again = await api().post(`/api/v1/orders/${order._id}/payment/razorpay`).set(customer.auth)
    expect(again.body.data.razorpayOrderId).toBe('order_test_1')
    expect(razorpayClient.createOrder).toHaveBeenCalledTimes(1)
    const resubmit = await api().post('/api/v1/orders').set(customer.auth).send({ shippingAddress: address, paymentMethod: 'RAZORPAY' })
    expect(resubmit.status).toBe(200)
    expect(resubmit.body.data._id).toBe(order._id)
  })

  it('marks the order paid only after a valid signature, and clears purchased cart lines', async () => {
    const { customer, order, payment } = await placeOnlineOrder()
    const forged = await api().post(`/api/v1/orders/${order._id}/payment/razorpay/verify`).set(customer.auth).send({ razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'a'.repeat(64) })
    expect(forged.status).toBe(400)
    expect((await Order.findById(order._id).lean())!.paymentStatus).toBe('PENDING')

    const verified = await api().post(`/api/v1/orders/${order._id}/payment/razorpay/verify`).set(customer.auth).send({ razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(payment.razorpayOrderId, 'pay_1') })
    expect(verified.status).toBe(200)
    expect(verified.body.data).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' })
    expect((await Cart.findOne({ userId: customer.user.id }).lean())!.items).toHaveLength(0)
  })

  it('rejects a valid signature from a different order', async () => {
    const first = await placeOnlineOrder()
    const response = await api().post(`/api/v1/orders/${first.order._id}/payment/razorpay/verify`).set(first.customer.auth).send({ razorpay_order_id: 'order_other', razorpay_payment_id: 'pay_1', razorpay_signature: sign('order_other', 'pay_1') })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('PAYMENT_MISMATCH')
  })

  it('does not let another customer start or verify payment for an order', async () => {
    const { order, payment } = await placeOnlineOrder()
    const intruder = await loginAs()
    expect((await api().post(`/api/v1/orders/${order._id}/payment/razorpay`).set(intruder.auth)).status).toBe(404)
    expect((await api().post(`/api/v1/orders/${order._id}/payment/razorpay/verify`).set(intruder.auth).send({ razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(payment.razorpayOrderId, 'pay_1') })).status).toBe(404)
  })
})

describe('razorpay webhook', () => {
  it('rejects invalid signatures without side effects', async () => {
    const { payment, order } = await placeOnlineOrder()
    const response = await webhook(capturedEvent(payment.razorpayOrderId), { secret: 'wrong-secret' })
    expect(response.status).toBe(400)
    expect((await Order.findById(order._id).lean())!.paymentStatus).toBe('PENDING')
    expect(await PaymentEvent.countDocuments()).toBe(0)
  })

  it('verifies against the raw body: a re-serialised body with the same data fails', async () => {
    const { payment } = await placeOnlineOrder()
    const body = capturedEvent(payment.razorpayOrderId)
    const signature = createHmac('sha256', webhookSecret).update(JSON.stringify(body, null, 2)).digest('hex')
    const response = await api().post('/api/v1/payments/razorpay/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', signature).send(JSON.stringify(body))
    expect(response.status).toBe(400)
  })

  it('marks the order paid once and acknowledges duplicate deliveries without reprocessing', async () => {
    const { payment, order } = await placeOnlineOrder()
    const first = await webhook(capturedEvent(payment.razorpayOrderId))
    expect(first.body.data.outcome).toBe('marked_paid')
    const duplicate = await webhook(capturedEvent(payment.razorpayOrderId))
    expect(duplicate.body.data.duplicate).toBe(true)
    const otherEvent = await webhook({ ...capturedEvent(payment.razorpayOrderId), event: 'order.paid' }, { eventId: 'evt_2' })
    expect(otherEvent.body.data.outcome).toBe('already_paid')
    const stored = await Order.findById(order._id).lean()
    expect(stored).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' })
    expect(stored!.statusHistory.filter((entry) => entry.status === 'CONFIRMED')).toHaveLength(1)
  })

  it('records payment failures but keeps the order payable until it expires', async () => {
    const { payment, order } = await placeOnlineOrder()
    const failed = await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_f', order_id: payment.razorpayOrderId, status: 'failed', error_description: 'Card declined' } } } })
    expect(failed.body.data.outcome).toBe('marked_failed')
    expect(await Order.findById(order._id).lean()).toMatchObject({ paymentStatus: 'FAILED', status: 'PENDING_PAYMENT' })
    // A later successful attempt still confirms the order.
    await webhook(capturedEvent(payment.razorpayOrderId, 'pay_ok'), { eventId: 'evt_ok' })
    expect(await Order.findById(order._id).lean()).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' })
  })

  it('acknowledges events for unknown orders so the provider stops retrying', async () => {
    const response = await webhook(capturedEvent('order_unknown'))
    expect(response.status).toBe(200)
    expect(response.body.data.outcome).toBe('unknown_order')
  })
})

describe('reservation expiry', () => {
  it('cancels unpaid orders after the window and returns their stock exactly once', async () => {
    vi.spyOn(razorpayClient, 'fetchOrder').mockResolvedValue({ id: 'x', amount: 0, currency: 'INR', status: 'attempted' })
    const { product, order } = await placeOnlineOrder()
    const later = new Date(Date.now() + 60 * 60_000)
    expect(await expireUnpaidOrders(later)).toBe(1)
    expect(await expireUnpaidOrders(later)).toBe(0)
    expect(await Order.findById(order._id).lean()).toMatchObject({ status: 'CANCELLED', cancelledBy: 'system' })
    expect((await Product.findById(product.id).lean())!.stock).toBe(5)
  })

  it('confirms instead of cancelling when the provider reports the order paid', async () => {
    vi.spyOn(razorpayClient, 'fetchOrder').mockResolvedValue({ id: 'x', amount: 0, currency: 'INR', status: 'paid' })
    vi.spyOn(razorpayClient, 'fetchOrderPayments').mockResolvedValue({ items: [{ id: 'pay_late', status: 'captured' }] })
    const { product, order } = await placeOnlineOrder()
    await expireUnpaidOrders(new Date(Date.now() + 60 * 60_000))
    expect(await Order.findById(order._id).lean()).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' })
    expect((await Product.findById(product.id).lean())!.stock).toBe(3)
  })

  it('re-reserves stock when a payment lands after expiry', async () => {
    vi.spyOn(razorpayClient, 'fetchOrder').mockResolvedValue({ id: 'x', amount: 0, currency: 'INR', status: 'created' })
    const { product, order, payment } = await placeOnlineOrder()
    await expireUnpaidOrders(new Date(Date.now() + 60 * 60_000))
    await webhook(capturedEvent(payment.razorpayOrderId, 'pay_late'))
    expect(await Order.findById(order._id).lean()).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' })
    expect((await Product.findById(product.id).lean())!.stock).toBe(3)
  })

  it('flags a refund instead of reviving an order the customer cancelled', async () => {
    const { customer, product, order, payment } = await placeOnlineOrder()
    expect((await api().post(`/api/v1/orders/${order._id}/cancel`).set(customer.auth)).status).toBe(200)
    await webhook(capturedEvent(payment.razorpayOrderId, 'pay_after_cancel'))
    const stored = await Order.findById(order._id).lean()
    expect(stored).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID' })
    expect(stored!.statusHistory.at(-1)!.note).toMatch(/REFUND REQUIRED/)
    expect((await Product.findById(product.id).lean())!.stock).toBe(5)
  })
})
