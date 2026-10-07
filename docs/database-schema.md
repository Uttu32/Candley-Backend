# Database schema

| Collection | Purpose | Key indexes |
|---|---|---|
| `users` | Customers and admins. `passwordHash` and reset-token fields are `select: false`. Embedded `addresses[]`, `tokenVersion` for revoking sessions | `email` unique, `{role, createdAt}` |
| `refreshtokens` | One row per refresh-token session (rotated) | `tokenId` unique, `userId`, TTL on `expiresAt` |
| `products` | Catalogue with embedded `variants[]` (`label, sku, price, stock, active`), fragrance notes, specifications, SEO. For variant products `stock` is the sum of active variant stock | `slug` unique, `sku` unique, `variants.sku` unique sparse, `{status, category}`, `{status, collection}`, `{status, featured, rating}`, `{status, createdAt}`, `tags`, text index |
| `categories` | Storefront categories | `slug` unique |
| `carts` | One per user: `items[{productId, variantId?, quantity}]`; `updatedAt` doubles as the checkout claim token | `userId` unique |
| `wishlists` | One per user: `productIds[]` | `userId` unique |
| `orders` | Immutable line snapshots (name, SKU, variant label, image, price), address snapshot, totals, coupon, payment state, `statusHistory`, reservation expiry | `orderNumber` unique, `{userId, createdAt}`, `{status, createdAt}`, `{paymentStatus, createdAt}`, `payment.razorpayOrderId` unique sparse, `{userId, idempotencyKey}` unique partial, `{status, reservationExpiresAt}` partial |
| `coupons` | Discount codes with validity window, limits and eligibility | `code` unique |
| `paymentevents` | Processed Razorpay webhook events, for idempotency | `eventId` unique |
| `storesettings` | Singleton: shipping fee and threshold, COD rules, per-item quantity cap | — |
| `heroslides` | Homepage slider CMS | `{active, sortOrder, createdAt}` |
| `announcements` | Announcement bar singleton | — |
