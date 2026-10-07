# Payment flow

## Razorpay

1. `POST /orders` with `paymentMethod: "RAZORPAY"` prices the server-side cart and validates the coupon and stock. It then reserves stock atomically (in a transaction when available) and creates the order as `PENDING_PAYMENT` with `reservationExpiresAt`.
2. `POST /orders/:id/payment/razorpay` creates a Razorpay order for the **stored** total (in paise) and returns `keyId` and `razorpayOrderId` for Razorpay Checkout. Repeat calls reuse it.
3. After Checkout succeeds, the storefront calls `POST /orders/:id/payment/razorpay/verify` with the three `razorpay_*` fields. The server checks that the Razorpay order belongs to this order and verifies `HMAC_SHA256(order_id|payment_id, key_secret)` before marking it `PAID`/`CONFIRMED`.
4. The webhook (`payment.captured`/`order.paid`/`payment.failed`) is verified against the raw body and processed once per event id. It confirms payments even if the browser never returned.
5. Every minute, the sweeper cancels unpaid orders past their reservation and returns their stock. It first asks Razorpay whether the order was paid, and confirms it if so.
6. A payment arriving after an automatic expiry re-reserves stock when possible. A payment for an order that the customer or admin cancelled, or with no stock left, is recorded as `PAID` with a **REFUND REQUIRED** note in `statusHistory`. Refunds are made in the Razorpay dashboard.

The frontend success callback alone never marks an order paid.

## Cash on delivery

COD is checked server-side against `storesettings.codEnabled` and `codMaxOrderValue`. The order is created `CONFIRMED`/`PENDING`, stock is deducted and the cart cleared. An admin records collection with `POST /admin/orders/:id/cod-collected` once the order is `SHIPPED` or `DELIVERED`.
