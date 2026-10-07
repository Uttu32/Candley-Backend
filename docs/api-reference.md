# API reference

Base path: `/api/v1`. Bodies are JSON unless marked *multipart*.

**Envelope.** Success: `{ success: true, message, data }`. Error: `{ success: false, message, error: { code, message, details? } }`. The top-level `message` is human-readable and safe to show to users.

**Auth.** Send `Authorization: Bearer <accessToken>`. When it expires (401), call `POST /auth/refresh` with the `candley_refresh_token` cookie (`credentials: 'include'`).

**Status codes.** 400 validation · 401 unauthenticated or invalid session · 403 wrong role · 404 not found, or not yours · 409 conflict (stock, duplicates, state transitions) · 413 too large · 415 bad file type · 422 business rule · 429 rate limited · 502/503 provider unavailable.

**Identifiers.** All `:id` params are 24-hex ObjectIds (anything else returns 400). Product detail is looked up by slug (`^[a-z0-9]+(-[a-z0-9]+)*$`).

## Auth: `/auth`

| Method | Path | Auth | Body | Data |
|---|---|---|---|---|
| POST | `/auth/register` | — (rate limited) | `{ name 2-100, email, password 8-128 }` | public user. Role is always `CUSTOMER` |
| POST | `/auth/login` | — (rate limited) | `{ email, password }` | `{ accessToken, user }` plus refresh cookie. Shared by customers and admins; `user.role` comes from the database. Generic 401 `INVALID_CREDENTIALS` on any failure |
| POST | `/auth/refresh` | refresh cookie | — | `{ accessToken, user }`, rotates the cookie. Replaying an old token revokes all sessions |
| POST | `/auth/logout` | refresh cookie | — | `null` |
| GET | `/auth/me` | customer+ | — | `{ id, _id, name, email, phone, dateOfBirth, role, emailVerified }` |
| PATCH | `/auth/me` | customer+ | `{ name, email, phone?, dateOfBirth? }` | public user. Other fields are ignored; 409 if the email is taken |
| POST | `/auth/change-password` | customer+ | `{ currentPassword, newPassword }` | new `{ accessToken, user }`; all other sessions are revoked |
| POST | `/auth/forgot-password` | — | `{ email }` | `null`. Same response whether or not the account exists; emails a 30-minute link to `CLIENT_URL/reset-password?token=…` |
| POST | `/auth/reset-password` | — | `{ token, password }` | `null`. Single use; revokes all sessions |

## Account: `/account` (customer+)

| Method | Path | Body | Data |
|---|---|---|---|
| GET | `/account/addresses` | — | `Address[]` |
| POST | `/account/addresses` | `{ label?, name, phone, addressLine1, addressLine2?, city, state, postalCode, country?, isDefault? }` | `Address[]` (max 10; the first address becomes default) |
| PATCH | `/account/addresses/:addressId` | any subset of the above | `Address[]` |
| DELETE | `/account/addresses/:addressId` | — | `Address[]` |

## Catalogue: `/products` (public)

| Method | Path | Query | Data |
|---|---|---|---|
| GET | `/products` | `q`, `category`, `collection`, `minPrice`, `maxPrice`, `featured=true\|false`, `inStock=true`, `sort=featured\|price_low_high\|price_high_low\|rating\|newest`, `page`, `limit≤100` | `{ items: Product[], pagination: { page, limit, total, totalPages } }`. Only `ACTIVE`/`OUT_OF_STOCK` products are shown |
| GET | `/products/categories` | — | active categories with `count` |
| GET | `/products/featured` | `limit≤24` | `Product[]` |
| GET | `/products/best-sellers` | `limit≤24` | `Product[]` with `unitsSold`, ranked from non-cancelled orders |
| GET | `/products/:slug` | — | `Product` (inactive variants hidden) |
| GET | `/products/:slug/related` | `limit≤24` | `Product[]` (same collection > category > shared tags) |

`Product.variants[]`: `{ _id, label, sku, price, stock, active }`. `_id` is stable across admin edits.

## CMS (public)

| Method | Path | Data |
|---|---|---|
| GET | `/cms/hero` | `HeroSlide[]` sorted by `sortOrder`. Only slides that are active, inside their `startsAt`/`endsAt` window, and have a desktop image or video. Cached for 60 s |
| GET | `/cms/announcement` | announcement bar settings |
| GET | `/cms/checkout-options` | `{ codEnabled, codMaxOrderValue, razorpayEnabled, shippingFee, freeShippingThreshold, maxQuantityPerItem }` (no secrets) |

`HeroSlide`: `{ _id, heading, subheading, ctaText, ctaUrl, secondaryCta?: { text, url }, desktopImage, mobileImage, imageAlt, desktopVideo, mobileVideo, backgroundVideo (legacy = desktopVideo), posterImage, overlayPosition, textAlignment, overlay: { color, opacity }, active, sortOrder, startsAt?, endsAt? }`

## Cart: `/cart` (customer+)

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/cart` | — | returns `CartView` |
| POST | `/cart/items` | `{ productId, variantId?, quantity 1-99 }` | Adds to an existing line. `variantId` may be omitted or `"default"` for products with no variants or one variant. Errors: 409 `INSUFFICIENT_STOCK`/`OUT_OF_STOCK`, 422 `VARIANT_REQUIRED`/`VARIANT_UNAVAILABLE`/`QUANTITY_LIMIT` |
| PATCH | `/cart/items/:productId` | `{ quantity 0-99, variantId? }` or `?variantId=` | 0 removes the line. `variantId` is required only when the product has several lines |
| DELETE | `/cart/items/:productId` | `?variantId=` | without `variantId`, removes every line for the product |
| DELETE | `/cart` | — | clears the cart |

`CartView`: `{ userId, items: [{ _id, productId: Product, variantId?, variant: {…}|null, quantity, unitPrice, lineTotal, available, maxQuantity, issue, issueMessage }], subtotal, itemCount, hasIssues }`. Prices are always current database prices. Unavailable lines have `available: false` and `lineTotal: 0`.

## Wishlist: `/wishlist` (customer+)

`GET /wishlist`, `POST /wishlist { productId }`, `DELETE /wishlist/:productId`, `DELETE /wishlist`. Each returns `{ userId, productIds: Product[] }`. There are no duplicates (max 200), and archived products are hidden.

## Orders and payments: `/orders` (customer+, own orders only)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/orders` | `?page&limit≤50` | `Order[]` (array; totals in `X-Total-Count`/`X-Total-Pages` headers) |
| POST | `/orders/quote` | `{ couponCode? }` | Server totals for the current cart without creating an order: `{ items, subtotal, discount, couponCode, couponError, shipping, tax, total, currency, freeShippingThreshold, paymentMethods: { cod|razorpay: { available, reason } } }`. Uses the same pricing as checkout; invalid coupons are reported in `couponError` |
| GET | `/orders/:id` | — | `Order` |
| POST | `/orders` | `{ shippingAddress \| addressId, paymentMethod: 'COD'\|'RAZORPAY', couponCode?, idempotencyKey? }` plus optional `Idempotency-Key` header | Creates the order from the **server-side cart** and returns 201 (or 200 with the existing order for a repeated key or identical pending online checkout). Any client-sent prices, totals or statuses are ignored. Errors: 422 `CART_EMPTY`/`COUPON_INVALID`/`COD_UNAVAILABLE`, 409 `CART_ITEMS_UNAVAILABLE` (details list each line)/`INSUFFICIENT_STOCK`/`CHECKOUT_CONFLICT`, 503 `PAYMENTS_UNAVAILABLE`. Rate limited |
| POST | `/orders/:id/cancel` | `{ reason? }` | Allowed while `PENDING_PAYMENT` or `CONFIRMED`; restores stock and coupon use. 409 otherwise |
| POST | `/orders/:id/payment/razorpay` | — | `{ keyId, razorpayOrderId, amount (paise), currency, orderId, orderNumber, reservationExpiresAt }` for Razorpay Checkout. Reuses the provider order on repeat calls |
| POST | `/orders/:id/payment/razorpay/verify` | `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` | Verifies the HMAC, then marks the order `PAID`/`CONFIRMED` and removes the purchased lines from the cart. 400 `INVALID_SIGNATURE`/`PAYMENT_MISMATCH` |

**Order lifecycle.**

- COD: placed as `CONFIRMED`/`PENDING`. Stock is deducted and the cart cleared immediately. Payment becomes `PAID` only when an admin records collection.
- Razorpay: placed as `PENDING_PAYMENT`/`PENDING`. Stock is reserved for `PAYMENT_RESERVATION_MINUTES`; the cart is kept until payment. Verify or webhook moves it to `CONFIRMED`/`PAID`. If not paid in time it is cancelled and the stock returned (after checking with Razorpay first).

`Order` fields: `_id, orderNumber, items[{ productId, variantId?, productName, productSlug, variantLabel?, sku, image, thumbnailImage, unitPrice, quantity, lineTotal }], shippingAddress, subtotal, discount, couponCode?, shipping, tax, total, currency, paymentMethod, paymentStatus (PENDING|PAID|FAILED|REFUNDED), status (PENDING_PAYMENT|CONFIRMED|PROCESSING|SHIPPED|DELIVERED|CANCELLED), payment{ razorpayOrderId?, razorpayPaymentId?, paidAt?, failureReason? }, reservationExpiresAt?, statusHistory[], cancelledAt?, cancellationReason?, cancelledBy?, createdAt, updatedAt`.

### Webhook

`POST /payments/razorpay/webhook` (Razorpay only). The `X-Razorpay-Signature` header is verified against the raw body using `RAZORPAY_WEBHOOK_SECRET`. It handles `payment.captured`, `order.paid` and `payment.failed`. Each `X-Razorpay-Event-Id` is processed once, and duplicates are acknowledged with `{ duplicate: true }`.

## Admin: `/admin` (ADMIN or SUPER_ADMIN unless noted)

| Method | Path | Notes |
|---|---|---|
| POST | `/admin/login` | public, rate limited. Admin-only variant of `/auth/login` (non-admins get a generic 401) |
| POST | `/admin/logout` | public |
| GET | `/admin/me` | |
| GET | `/admin/dashboard` | `?from&to&lowStockThreshold`. Returns `{ totalSales, totalOrders, paidOrders, totalCustomers, newCustomers, pendingOrders, totalProducts, outOfStockProducts, lowStockProducts, averageOrderValue, revenueSeries[{label,value}], topProducts[], ordersByStatus[] }`, all aggregated from stored data (`averageOrderValue` is over paid orders; series grouped in Asia/Kolkata days) |
| GET | `/admin/products` | `?page&limit&search&status&category&lowStock` |
| GET | `/admin/products/:id` | |
| POST | `/admin/products` | *multipart*: `product` (JSON) + `images[]` (≤12, ≤8 MB, jpeg/png/webp/avif, checked by content) + `thumbnailIndex`; JSON body also accepted |
| PATCH | `/admin/products/:id` | as POST, but fields are optional; `removeImages` (JSON array of URLs). Variants match existing ones by `_id`, then SKU, then label, so IDs stay stable; a blank variant `sku` keeps the stored one |
| PATCH | `/admin/products/:id/status` | `{ status: DRAFT\|ACTIVE\|OUT_OF_STOCK\|ARCHIVED }` |
| PATCH | `/admin/products/:id/inventory` | `{ stock }` \| `{ delta }` \| `{ variantId, stock }` \| `{ variantId, delta }`. Atomic; never below 0 |
| DELETE | `/admin/products/:id/images` | `{ url }` |
| DELETE | `/admin/products/:id` | Hard delete; archives instead if any order references the product |
| GET/POST | `/admin/categories` | `{ name, slug, image?, description?, active?, sortOrder? }` |
| PATCH/DELETE | `/admin/categories/:id` | Delete returns 409 while products use the category |
| GET/POST | `/admin/coupons` | `{ code, discountType: PERCENT\|FIXED, amount, minOrderValue?, maxDiscount?, startsAt?, endsAt?, usageLimit?, perCustomerLimit?, productIds?, categories?, active?, description? }` |
| PATCH/DELETE | `/admin/coupons/:id` | Delete deactivates coupons that have already been used |
| GET | `/admin/orders` | `?page&limit&status&paymentStatus&paymentMethod&search&customerId&from&to`. `userId` is populated with name/email |
| GET | `/admin/orders/:id` | |
| PATCH | `/admin/orders/:id/status` | `{ status, note? }`. Allowed: CONFIRMED→PROCESSING→SHIPPED→DELIVERED, and →CANCELLED from PENDING_PAYMENT, CONFIRMED or PROCESSING (restocks). 409 `INVALID_STATUS_TRANSITION` otherwise |
| POST | `/admin/orders/:id/cod-collected` | COD orders that are SHIPPED or DELIVERED only |
| GET | `/admin/customers` | `?page&limit&search&status`. Includes `orderCount` and `totalSpent`; no secrets |
| GET | `/admin/customers/:id` | profile, addresses and recent orders |
| PATCH | `/admin/customers/:id/status` | `{ status: ACTIVE\|BLOCKED\|SUSPENDED }`. Customers only; blocking revokes sessions. Roles cannot be changed through the API |
| GET | `/admin/cms/hero` | all slides, including inactive ones |
| GET | `/admin/cms/hero/:id` | |
| POST | `/admin/cms/hero` | `HeroSlide` fields (`heading` required). Links must be `/path` or `https://`. Unknown fields are rejected |
| PATCH | `/admin/cms/hero/:id` | partial update, validated against the merged slide. Replaced Cloudinary media is deleted |
| PUT | `/admin/cms/hero/order` | `{ ids: [...] }`. Must list every slide exactly once; sets `sortOrder` to 1..n |
| POST | `/admin/cms/hero/:id/activate` · `/deactivate` | |
| POST | `/admin/cms/hero/:id/image` | *multipart* `image` + `target=desktopImage\|mobileImage\|posterImage` |
| POST | `/admin/cms/hero/:id/video` | *multipart* `video` (mp4/webm, ≤40 MB) + `target=desktopVideo\|mobileVideo` |
| DELETE | `/admin/cms/hero/:id` | also deletes its Cloudinary media |
| POST | `/admin/media/signature` | `{ folder: products\|hero, resourceType: image\|video }`. Signed parameters for direct browser-to-Cloudinary upload of large files; then save the returned `secure_url` through PATCH |
| GET/PUT | `/admin/settings/announcement` | |
| GET/PUT | `/admin/settings/store` | `{ shippingFee, freeShippingThreshold, codEnabled, codMaxOrderValue (null = no limit), maxQuantityPerItem }` |

## Health

`GET /live`, `GET /health` (liveness), `GET /ready` (200 when MongoDB is connected, else 503). No infrastructure details are exposed.
