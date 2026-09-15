# Payment flow

Razorpay is not enabled by the initial COD slice. The production flow must be:

1. Validate cart, address, price, stock, coupon, tax, and shipping on the backend.
2. Reserve inventory atomically with an expiring reservation.
3. Create a Razorpay order from the backend-calculated amount.
4. Verify the checkout signature server-side.
5. Verify webhook signatures and persist event IDs for idempotency.
6. Reconcile payment state before confirming the order.
7. Commit inventory deduction and clear the cart in a MongoDB transaction.
8. Release reservations on payment failure or expiry.

The frontend must never mark an order paid from its own callback alone.
