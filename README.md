# Candley Aroma Backend

TypeScript/Express 5 + MongoDB (Mongoose 9) API for the Candley Aroma storefront and admin panel.

## Features

- Shared customer/admin login (Argon2 hashes, 15-minute access tokens, rotated HTTP-only refresh cookies with replay detection). Role and account status are re-read from the database on every request.
- Registration, profile, saved addresses, password change, and forgot/reset password by email.
- Product catalogue with variants (stable variant IDs, unique SKUs), search, filters, sorting, pagination, best sellers from real orders, and related products.
- Persistent cart and wishlist with server-side prices, stock and quantity limits.
- Checkout with server-calculated totals, coupons, configurable shipping and COD rules. Stock reservation is atomic: MongoDB transactions where available, explicit compensation otherwise.
- Razorpay: server-created payment orders, checkout signature verification, raw-body webhook verification, and idempotent event processing. Unpaid orders release their reservations automatically.
- Admin APIs for products, inventory, categories, coupons, orders (status workflow, COD collection), customers, the hero slider CMS, the announcement bar, store settings, Cloudinary media and the dashboard.
- Helmet, strict CORS in production, rate limits on auth and checkout, request size limits, NoSQL/regex injection protection, and log redaction.

See [docs/api-reference.md](docs/api-reference.md) for every endpoint.

## Run locally

1. Copy `.env.example` to `.env` and fill in the values (see [Environment](#environment)).
2. Start MongoDB, for example with `docker compose up -d mongo` or by pointing `MONGO_URI` at an Atlas cluster.
3. `npm install`
4. `npm run db:sync-indexes -- --apply` creates the indexes. Run it without `--apply` first for a dry run.
5. `npm run admin:create -- --email you@example.com --name "Your Name"` creates the first administrator (see below).
6. Optional: `npm run seed` adds sample categories and a product. It is development only and refuses to run in production.
7. `npm run dev`

The API listens on `http://localhost:5000`. `/live` and `/health` are liveness checks; `/ready` reports database readiness. `/docs` is only served outside production.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Watch mode with tsx |
| `npm run build` | Compile `src/` to `dist/` (uses `tsconfig.build.json`) |
| `npm start` / `npm run start:prod` | Run with tsx / run the compiled build |
| `npm test` | Integration tests against an in-memory MongoDB replica set |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint checks |
| `npm run admin:create` | Provision or promote an administrator |
| `npm run db:sync-indexes` | Check for duplicates, then create and drop indexes to match the schemas |

## Administrator provisioning

There is no public admin sign-up, and no credentials live in code or `.env`. Create admins with:

```bash
npm run admin:create -- --email owner@example.com --name "Store Owner" [--role SUPER_ADMIN]
```

The password is prompted for without echo, or read from `ADMIN_BOOTSTRAP_PASSWORD` for non-interactive deploys (unset it afterwards). It must be at least 12 characters and is never printed.

- An existing customer is only promoted with `--promote`.
- An existing admin is left unchanged unless you pass `--reset-password`.
- Promotion or reset revokes the account's existing sessions.

## Environment

Required: `NODE_ENV`, `PORT`, `CLIENT_URL`, `ADMIN_URL`, `MONGO_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`. The two JWT secrets must each be at least 32 characters and must differ in production.

Optional:

- Session: `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `COOKIE_DOMAIN`, `CORS_ORIGINS` (comma-separated extra origins)
- Razorpay: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (required in production when Razorpay is enabled), `PAYMENT_RESERVATION_MINUTES` (default 30)
- Cloudinary: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (all or none)
- Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (`MAIL_FROM` is required when `SMTP_HOST` is set)
- `LOG_LEVEL`

Startup fails with a list of the offending variable **names** when configuration is invalid. Values are never printed.

## Tests

`npm test` starts a single-node in-memory MongoDB **replica set** (so transactions are exercised for real). Each test file uses its own database, and the helpers refuse to run against any non-local host. Checkout tests run twice: once with transactions and once in compensation mode, the path a standalone MongoDB server uses. No real Razorpay, Cloudinary or SMTP calls are made; the Razorpay client is stubbed and email is captured in memory.

The first run downloads a MongoDB binary (about 70 MB) into the user cache.

## Deployment notes

- Configure the Razorpay webhook to `POST {API_URL}/api/v1/payments/razorpay/webhook` with the events `payment.captured`, `payment.failed` and `order.paid`. Use the same secret as `RAZORPAY_WEBHOOK_SECRET`.
- Run `npm run db:sync-indexes` (dry run, then `--apply`) after deploying this version. It fixes the refresh-token TTL index and recomputes aggregate stock for variant products. See [docs/migration-notes.md](docs/migration-notes.md).
- The API runs a reservation sweeper every minute. With several instances each one runs it; this is safe because every cancellation is conditional and idempotent.
