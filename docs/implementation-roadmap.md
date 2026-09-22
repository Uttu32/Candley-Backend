# Implementation roadmap

## Slice 1: foundation (current)

- API bootstrap, environment validation, security middleware, logging
- MongoDB adapter with health/readiness checks
- Auth with Argon2, access tokens, HTTP-only rotated refresh tokens
- Product/category reads, authenticated cart/wishlist, server-calculated COD order creation

## Slice 2: transactional commerce

- Extract services from route handlers
- Inventory and immutable inventory transactions
- Atomic stock reservation with MongoDB transactions
- Razorpay order creation, signature verification, webhook persistence, idempotency
- Payment and order state machines

## Slice 3: customer operations

- Addresses, profile, password reset/email verification
- Coupons and promotion engine
- Shipping provider abstraction and COD serviceability
- Orders cancellation, returns, refunds, invoice snapshots
- Verified reviews and notification preferences

## Slice 4: operations and content

- Admin RBAC APIs, dashboard aggregation, audit logs, inventory adjustments
- Cloudinary/S3 media abstraction
- Homepage CMS, hero scheduling, settings
- BullMQ queues/workers for email, inventory expiry, abandoned carts, reports
- Analytics, aggregation reports, CSV/XLSX exports

## Slice 5: integration and verification

- Replace frontend mock imports and local cart/wishlist mutations with API/query hooks
- Add Razorpay frontend flow only after backend verification exists
- Integration, concurrency, payment, failure-mode, and end-to-end tests
- Production deployment, monitoring, backups, and security review
