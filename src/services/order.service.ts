import { createHash, randomInt } from 'node:crypto'
import { Types, type ClientSession } from 'mongoose'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { Cart } from '../models/Cart.js'
import { Order, type OrderStatus } from '../models/Order.js'
import { getStoreSettings } from '../models/StoreSettings.js'
import { User } from '../models/User.js'
import { ApiError } from '../utils/api-error.js'
import { issueMessages, loadProductsById, resolveLine } from './catalog.service.js'
import { consumeCoupon, evaluateCoupon, releaseCoupon } from './coupon.service.js'
import { releaseStock, reserveStock } from './inventory.service.js'
import { mailTemplates, queueMail } from './mailer.js'
import { razorpayClient, toPaise } from './razorpay.service.js'
import { Compensator, runAtomic } from './transaction.js'
import { isRazorpayConfigured } from '../config/env.js'

export type ShippingAddressInput = {
  name: string; phone: string; addressLine1: string; addressLine2?: string; city: string; state: string; postalCode: string; country: string
}

export type CheckoutInput = {
  userId: string
  shippingAddress?: ShippingAddressInput
  addressId?: string
  paymentMethod: 'RAZORPAY' | 'COD'
  couponCode?: string
  idempotencyKey?: string
}

type OrderDoc = NonNullable<Awaited<ReturnType<typeof Order.findOne>>>

const roundMoney = (value: number) => Math.round(value * 100) / 100

const generateOrderNumber = () => {
  const date = new Date()
  const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
  return `CAN-${stamp}-${randomInt(0, 36 ** 6).toString(36).toUpperCase().padStart(6, '0')}`
}

const resolveAddress = async (userId: string, input: CheckoutInput): Promise<ShippingAddressInput> => {
  if (input.shippingAddress) return input.shippingAddress
  if (!input.addressId) throw new ApiError(400, 'A shipping address is required', [], 'VALIDATION_ERROR')
  const user = await User.findById(userId).select('addresses').lean()
  const saved = user?.addresses?.find((address) => String(address._id) === input.addressId)
  if (!saved) throw new ApiError(404, 'Saved address not found')
  return { name: saved.name, phone: saved.phone, addressLine1: saved.addressLine1, addressLine2: saved.addressLine2 ?? '', city: saved.city, state: saved.state, postalCode: saved.postalCode, country: saved.country }
}

/** Builds priced order lines from the user's cart using database prices and stock. */
const priceCart = async (userId: string) => {
  const cart = await Cart.findOne({ userId }).lean()
  if (!cart?.items.length) throw new ApiError(422, 'Your cart is empty', [], 'CART_EMPTY')
  const settings = await getStoreSettings()
  const products = await loadProductsById(cart.items.map((item) => item.productId))
  const problems: Array<{ productId: string; variantId: string | null; issue: string; message: string }> = []
  const lines = cart.items.map((item) => {
    const variantId = item.variantId ? String(item.variantId) : undefined
    const resolved = resolveLine(products.get(String(item.productId)), variantId, item.quantity)
    const issue = item.quantity > settings.maxQuantityPerItem ? 'QUANTITY_LIMIT' : resolved.issue
    if (issue || !resolved.product) {
      problems.push({ productId: String(item.productId), variantId: variantId ?? null, issue: issue ?? 'PRODUCT_UNAVAILABLE', message: issue === 'QUANTITY_LIMIT' ? `Maximum ${settings.maxQuantityPerItem} per item` : issueMessages[issue ?? 'PRODUCT_UNAVAILABLE'] })
      return null
    }
    const image = resolved.product.thumbnailImage || resolved.product.images[0] || ''
    return {
      productId: resolved.product._id,
      variantId: resolved.variant?._id,
      productName: resolved.product.name,
      productSlug: resolved.product.slug,
      variantLabel: resolved.variant?.label,
      category: resolved.product.category,
      sku: resolved.sku,
      image,
      thumbnailImage: image,
      unitPrice: resolved.unitPrice,
      quantity: item.quantity,
      lineTotal: roundMoney(resolved.unitPrice * item.quantity),
    }
  })
  if (problems.length) throw new ApiError(409, 'Some items in your cart are unavailable. Please review your cart.', problems, 'CART_ITEMS_UNAVAILABLE')
  return { lines: lines.filter((line): line is NonNullable<typeof line> => line !== null), settings, cartSnapshot: cart.updatedAt }
}

const fingerprint = (input: { lines: Array<{ productId: unknown; variantId?: unknown; quantity: number; unitPrice: number }>; address: ShippingAddressInput; paymentMethod: string; couponCode?: string }) =>
  createHash('sha256').update(JSON.stringify({
    lines: input.lines.map((line) => [String(line.productId), String(line.variantId ?? ''), line.quantity, line.unitPrice]).sort(),
    address: input.address,
    paymentMethod: input.paymentMethod,
    coupon: input.couponCode?.toUpperCase() ?? '',
  })).digest('hex')

type Settings = Awaited<ReturnType<typeof getStoreSettings>>
type PricedLines = Awaited<ReturnType<typeof priceCart>>['lines']

/** Single source of truth for discount, shipping, total and payment-method availability. */
const computeTotals = async (userId: string, lines: PricedLines, settings: Settings, couponCode?: string) => {
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.lineTotal, 0))
  const couponResult = couponCode ? await evaluateCoupon(couponCode, userId, lines) : undefined
  const discount = couponResult?.discount ?? 0
  const discountedSubtotal = roundMoney(subtotal - discount)
  const shipping = discountedSubtotal >= settings.freeShippingThreshold ? 0 : settings.shippingFee
  const total = roundMoney(discountedSubtotal + shipping)
  const codLimit = settings.codMaxOrderValue
  const codReason = !settings.codEnabled
    ? 'Cash on delivery is not available'
    : codLimit !== undefined && codLimit !== null && total > codLimit ? `Cash on delivery is available for orders up to ₹${codLimit}` : null
  return {
    subtotal,
    couponResult,
    discount,
    shipping,
    total,
    payment: {
      cod: { available: codReason === null, reason: codReason },
      razorpay: { available: isRazorpayConfigured, reason: isRazorpayConfigured ? null : 'Online payments are not available right now' },
    },
  }
}

/**
 * Server-calculated preview of the current cart: the same pricing used by `createOrder`, without side effects.
 * Invalid coupons are reported instead of thrown so the checkout page can display them.
 */
export const quoteOrder = async (userId: string, couponCode?: string) => {
  const { lines, settings } = await priceCart(userId)
  let couponError: string | null = null
  let totals
  try {
    totals = await computeTotals(userId, lines, settings, couponCode)
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'COUPON_INVALID') throw error
    couponError = error.message
    totals = await computeTotals(userId, lines, settings)
  }
  return {
    items: lines.map(({ category: _category, ...line }) => line),
    subtotal: totals.subtotal,
    discount: totals.discount,
    couponCode: totals.couponResult?.coupon.code ?? null,
    couponError,
    shipping: totals.shipping,
    tax: 0,
    total: totals.total,
    currency: 'INR',
    freeShippingThreshold: settings.freeShippingThreshold,
    paymentMethods: totals.payment,
  }
}

export const createOrder = async (input: CheckoutInput) => {
  const { userId } = input
  if (input.idempotencyKey) {
    const existing = await Order.findOne({ userId, idempotencyKey: input.idempotencyKey }).lean()
    if (existing) return { order: existing, created: false }
  }

  const address = await resolveAddress(userId, input)
  const { lines, settings, cartSnapshot } = await priceCart(userId)

  const checkoutFingerprint = fingerprint({ lines, address, paymentMethod: input.paymentMethod, couponCode: input.couponCode })
  // A repeated submission of the same unpaid online checkout returns the order already holding the stock.
  const pending = await Order.findOne({ userId, checkoutFingerprint, status: 'PENDING_PAYMENT', reservationExpiresAt: { $gt: new Date() } }).lean()
  if (pending) return { order: pending, created: false }

  const { subtotal, couponResult, discount, shipping, total, payment } = await computeTotals(userId, lines, settings, input.couponCode)

  if (input.paymentMethod === 'COD') {
    if (!payment.cod.available) throw new ApiError(422, payment.cod.reason ?? 'Cash on delivery is not available', [], 'COD_UNAVAILABLE')
  } else if (!payment.razorpay.available) {
    throw new ApiError(503, 'Online payments are not available right now', [], 'PAYMENTS_UNAVAILABLE')
  }

  const isCod = input.paymentMethod === 'COD'
  const initialStatus: OrderStatus = isCod ? 'CONFIRMED' : 'PENDING_PAYMENT'

  const order = await runAtomic(async (session) => {
    const compensator = new Compensator(session)
    try {
      // Claim the exact cart state that was priced. A concurrent or repeated submission (or a retried
      // transaction) sees a different updatedAt and stops here, so one cart yields at most one order.
      const claimed = await Cart.updateOne({ userId, updatedAt: cartSnapshot }, { $set: { checkoutClaimedAt: new Date() } }, { session })
      if (claimed.modifiedCount !== 1) throw new ApiError(409, 'Your cart changed or is already being checked out. Please review your cart and try again.', [], 'CHECKOUT_CONFLICT')
      await reserveStock(lines, session, compensator)
      if (couponResult) await consumeCoupon(couponResult.coupon._id, session, compensator)
      const [created] = await Order.create([{
        orderNumber: generateOrderNumber(),
        userId,
        items: lines.map(({ category: _category, ...line }) => line),
        shippingAddress: { ...address, addressLine2: address.addressLine2 ?? '' },
        subtotal,
        discount,
        couponCode: couponResult?.coupon.code,
        couponId: couponResult?.coupon._id,
        shipping,
        tax: 0,
        total,
        paymentMethod: input.paymentMethod,
        paymentStatus: 'PENDING',
        status: initialStatus,
        statusHistory: [{ status: initialStatus, note: isCod ? 'Cash on delivery order placed' : 'Awaiting online payment' }],
        idempotencyKey: input.idempotencyKey,
        checkoutFingerprint,
        reservationExpiresAt: isCod ? undefined : new Date(Date.now() + env.PAYMENT_RESERVATION_MINUTES * 60_000),
      }], { session })
      // COD orders are final now; online orders keep the cart until payment succeeds.
      if (isCod) await Cart.updateOne({ userId }, { $set: { items: [] } }, { session })
      return created!
    } catch (error) {
      await compensator.rollback()
      if ((error as { code?: number }).code === 11000 && input.idempotencyKey) {
        const existing = await Order.findOne({ userId, idempotencyKey: input.idempotencyKey })
        if (existing) return existing
      }
      throw error
    }
  })

  if (isCod) notifyOrderConfirmed(order)
  return { order: order.toObject(), created: true }
}

const notifyOrderConfirmed = (order: OrderDoc) => {
  void User.findById(order.userId).select('name email').lean().then((user) => {
    if (user) queueMail({ to: user.email, ...mailTemplates.orderConfirmed(user.name, order) })
  }).catch(() => undefined)
}

const notifyStatus = (order: { userId: unknown; orderNumber: string }, status: string) => {
  void User.findById(order.userId).select('name email').lean().then((user) => {
    if (user) queueMail({ to: user.email, ...mailTemplates.orderStatus(user.name, order.orderNumber, status) })
  }).catch(() => undefined)
}

/** Creates (or reuses) the Razorpay order for an unpaid online order. Amount comes from the stored order. */
export const startRazorpayPayment = async (userId: string, orderId: string) => {
  const order = await Order.findOne({ _id: orderId, userId })
  if (!order) throw new ApiError(404, 'Order not found')
  if (order.paymentMethod !== 'RAZORPAY') throw new ApiError(422, 'This order is not an online payment order')
  if (order.paymentStatus === 'PAID') throw new ApiError(409, 'This order is already paid', [], 'ALREADY_PAID')
  if (order.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'This order can no longer be paid', [], 'ORDER_NOT_PAYABLE')

  if (!order.payment?.razorpayOrderId) {
    const created = await razorpayClient.createOrder({ amountPaise: toPaise(order.total), currency: order.currency, receipt: order.orderNumber, notes: { orderId: order.id } })
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, 'payment.razorpayOrderId': { $exists: false } },
      { $set: { 'payment.razorpayOrderId': created.id } },
      { new: true },
    )
    // A concurrent request may have attached a Razorpay order first; use whichever was stored.
    const stored = updated ?? (await Order.findById(order._id))
    order.set('payment', stored!.payment)
  }
  return {
    keyId: env.RAZORPAY_KEY_ID,
    razorpayOrderId: order.payment!.razorpayOrderId!,
    amount: toPaise(order.total),
    currency: order.currency,
    orderId: order.id,
    orderNumber: order.orderNumber,
    reservationExpiresAt: order.reservationExpiresAt,
  }
}

/**
 * Marks an order paid. Idempotent: repeated calls (checkout callback + webhook) have no further effect.
 * If the reservation already expired and stock was released, stock is re-reserved; when that is impossible
 * the order stays cancelled and is flagged for a refund.
 */
export const markOrderPaid = async (razorpayOrderId: string, razorpayPaymentId: string) => {
  const order = await Order.findOne({ 'payment.razorpayOrderId': razorpayOrderId })
  if (!order) throw new ApiError(404, 'Order not found for payment')
  if (order.paymentStatus === 'PAID') return { order, changed: false }

  // Only orders cancelled automatically for non-payment are revived; a customer/admin cancellation stands.
  if (order.status === 'CANCELLED' && order.cancelledBy === 'system') {
    const recovered = await runAtomic(async (session) => {
      const compensator = new Compensator(session)
      try {
        await reserveStock(order.items.map((item) => ({ productId: item.productId, variantId: item.variantId, quantity: item.quantity, productName: item.productName })), session, compensator)
        return Order.findOneAndUpdate(
          { _id: order._id, paymentStatus: { $ne: 'PAID' }, status: 'CANCELLED' },
          { $set: { paymentStatus: 'PAID', status: 'CONFIRMED', inventoryReleased: false, 'payment.razorpayPaymentId': razorpayPaymentId, 'payment.paidAt': new Date() }, $unset: { cancelledAt: 1, cancellationReason: 1, cancelledBy: 1 }, $push: { statusHistory: { status: 'CONFIRMED', note: 'Payment received after reservation expiry; stock re-reserved' } } },
          { new: true, session },
        )
      } catch (error) {
        await compensator.rollback()
        if (error instanceof ApiError && error.code === 'INSUFFICIENT_STOCK') return null
        throw error
      }
    })
    if (recovered) {
      await Cart.updateOne({ userId: recovered.userId }, { $set: { items: [] } })
      notifyOrderConfirmed(recovered)
      return { order: recovered, changed: true }
    }
    const flagged = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: { $ne: 'PAID' } },
      { $set: { paymentStatus: 'PAID', 'payment.razorpayPaymentId': razorpayPaymentId, 'payment.paidAt': new Date() }, $push: { statusHistory: { status: 'CANCELLED', note: 'Payment received after cancellation and stock is unavailable: REFUND REQUIRED' } } },
      { new: true },
    )
    logger.error({ orderNumber: order.orderNumber }, 'Payment captured for a cancelled order without stock; refund required')
    return { order: flagged ?? order, changed: Boolean(flagged) }
  }

  if (order.status === 'CANCELLED') {
    const flagged = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: { $ne: 'PAID' } },
      { $set: { paymentStatus: 'PAID', 'payment.razorpayPaymentId': razorpayPaymentId, 'payment.paidAt': new Date() }, $push: { statusHistory: { status: 'CANCELLED', note: 'Payment received after the order was cancelled: REFUND REQUIRED' } } },
      { new: true },
    )
    logger.error({ orderNumber: order.orderNumber }, 'Payment captured for a cancelled order; refund required')
    return { order: flagged ?? order, changed: Boolean(flagged) }
  }

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $ne: 'PAID' }, status: 'PENDING_PAYMENT' },
    { $set: { paymentStatus: 'PAID', status: 'CONFIRMED', 'payment.razorpayPaymentId': razorpayPaymentId, 'payment.paidAt': new Date() }, $unset: { reservationExpiresAt: 1, 'payment.failureReason': 1 }, $push: { statusHistory: { status: 'CONFIRMED', note: 'Online payment received' } } },
    { new: true },
  )
  if (!updated) return { order: (await Order.findById(order._id))!, changed: false }
  // Remove purchased lines from the cart; anything added after checkout stays.
  await Cart.updateOne({ userId: updated.userId }, { $pull: { items: { $or: updated.items.map((item) => ({ productId: item.productId, variantId: item.variantId ?? null })) } } })
  notifyOrderConfirmed(updated)
  return { order: updated, changed: true }
}

/** Records a failed attempt. The order stays payable (Razorpay allows retries) until its reservation expires. */
export const markPaymentFailed = async (razorpayOrderId: string, reason: string | undefined) => {
  const updated = await Order.findOneAndUpdate(
    { 'payment.razorpayOrderId': razorpayOrderId, paymentStatus: { $ne: 'PAID' } },
    { $set: { paymentStatus: 'FAILED', 'payment.failureReason': (reason ?? 'Payment failed').slice(0, 300) } },
    { new: true },
  )
  if (updated) {
    void User.findById(updated.userId).select('name email').lean().then((user) => {
      if (user) queueMail({ to: user.email, ...mailTemplates.paymentFailed(user.name, updated.orderNumber) })
    }).catch(() => undefined)
  }
  return updated
}

const cancellable: Record<'customer' | 'admin' | 'system', OrderStatus[]> = {
  customer: ['PENDING_PAYMENT', 'CONFIRMED'],
  admin: ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING'],
  system: ['PENDING_PAYMENT'],
}

/** Cancels an order, returning reserved stock and coupon usage exactly once. */
export const cancelOrder = async (orderId: string | Types.ObjectId, actor: { kind: 'customer' | 'admin' | 'system'; userId?: string }, reason?: string) => {
  const filter: Record<string, unknown> = { _id: orderId, status: { $in: cancellable[actor.kind] } }
  if (actor.kind === 'customer') filter.userId = actor.userId
  if (actor.kind === 'system') filter.paymentStatus = { $ne: 'PAID' }

  const result = await runAtomic(async (session: ClientSession | undefined) => {
    const order = await Order.findOneAndUpdate(
      filter,
      {
        $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actor.kind, cancellationReason: reason?.slice(0, 300), inventoryReleased: true },
        $unset: { reservationExpiresAt: 1 },
        $push: { statusHistory: { status: 'CANCELLED', note: reason?.slice(0, 300) ?? `Cancelled by ${actor.kind}`, changedBy: actor.userId } },
      },
      { new: false, session },
    )
    if (!order) return null
    if (!order.inventoryReleased) {
      await releaseStock(order.items.map((item) => ({ productId: item.productId, variantId: item.variantId, quantity: item.quantity })), session)
      if (order.couponId) await releaseCoupon(order.couponId, session)
    }
    return Order.findById(order._id).session(session ?? null)
  })

  if (!result) {
    const existing = await Order.findOne(actor.kind === 'customer' ? { _id: orderId, userId: actor.userId } : { _id: orderId }).lean()
    if (!existing) throw new ApiError(404, 'Order not found')
    throw new ApiError(409, `Orders that are ${existing.status.replaceAll('_', ' ').toLowerCase()} cannot be cancelled`, [], 'INVALID_STATUS_TRANSITION')
  }
  if (result.paymentStatus === 'PAID') {
    await Order.updateOne({ _id: result._id }, { $push: { statusHistory: { status: 'CANCELLED', note: 'Order was paid online: REFUND REQUIRED' } } })
    logger.warn({ orderNumber: result.orderNumber }, 'Paid order cancelled; refund required')
  }
  if (actor.kind !== 'system') notifyStatus(result, 'CANCELLED')
  return result
}

/** Allowed admin transitions. Cancellation goes through `cancelOrder`. */
const transitions: Partial<Record<OrderStatus, OrderStatus[]>> = {
  CONFIRMED: ['PROCESSING'],
  PROCESSING: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
}

export const updateOrderStatus = async (orderId: string, status: OrderStatus, adminId: string, note?: string) => {
  if (status === 'CANCELLED') return cancelOrder(orderId, { kind: 'admin', userId: adminId }, note)
  const current = await Order.findById(orderId).lean()
  if (!current) throw new ApiError(404, 'Order not found')
  if (!transitions[current.status as OrderStatus]?.includes(status)) {
    throw new ApiError(409, `Cannot change status from ${current.status} to ${status}`, [], 'INVALID_STATUS_TRANSITION')
  }
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: current.status },
    { $set: { status }, $push: { statusHistory: { status, note: note?.slice(0, 300), changedBy: adminId } } },
    { new: true },
  )
  if (!updated) throw new ApiError(409, 'Order was modified concurrently; reload and try again', [], 'CONCURRENT_UPDATE')
  notifyStatus(updated, status)
  return updated
}

/** COD payment collection is recorded by an admin once the parcel has been handed over. */
export const markCodCollected = async (orderId: string, adminId: string) => {
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, paymentMethod: 'COD', paymentStatus: 'PENDING', status: { $in: ['SHIPPED', 'DELIVERED'] } },
    { $set: { paymentStatus: 'PAID', 'payment.paidAt': new Date() }, $push: { statusHistory: { status: 'DELIVERED', note: 'Cash on delivery payment collected', changedBy: adminId } } },
    { new: true },
  )
  if (!updated) throw new ApiError(409, 'Payment can only be recorded for shipped or delivered COD orders awaiting payment', [], 'INVALID_PAYMENT_TRANSITION')
  return updated
}

/**
 * Cancels unpaid online orders whose reservation expired, returning their stock. Before cancelling,
 * the provider is asked whether the order was in fact paid (e.g. a delayed webhook).
 */
export const expireUnpaidOrders = async (now = new Date()) => {
  const expired = await Order.find({ status: 'PENDING_PAYMENT', paymentStatus: { $ne: 'PAID' }, reservationExpiresAt: { $lte: now } }).limit(100).lean()
  let cancelled = 0
  for (const order of expired) {
    try {
      if (order.payment?.razorpayOrderId && isRazorpayConfigured) {
        const remote = await razorpayClient.fetchOrder(order.payment.razorpayOrderId)
        if (remote.status === 'paid') {
          // Paid but never confirmed (e.g. webhook lost): confirm instead of releasing stock.
          const payments = await razorpayClient.fetchOrderPayments(order.payment.razorpayOrderId)
          const captured = payments.items.find((payment) => payment.status === 'captured')
          if (captured) await markOrderPaid(order.payment.razorpayOrderId, captured.id)
          continue
        }
      }
      await cancelOrder(order._id, { kind: 'system' }, 'Payment not completed in time')
      cancelled += 1
    } catch (error) {
      logger.warn({ orderNumber: order.orderNumber, message: error instanceof Error ? error.message : String(error) }, 'Failed to expire unpaid order')
    }
  }
  return cancelled
}
