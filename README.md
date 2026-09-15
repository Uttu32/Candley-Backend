# Candley Aroma Backend

A separate TypeScript/Express backend for the Candley Aroma React storefront.

## Current foundation

- Express 5 API with versioned `/api/v1` routes
- MongoDB/Mongoose connection pooling and models for users, products, categories, carts, orders, and refresh tokens
- Redis connection and readiness checks
- Argon2 password hashing
- Short-lived access tokens and rotated HTTP-only refresh cookies
- Product filtering, pagination, search, authenticated cart and wishlist APIs
- Server-side checkout total calculation and COD order creation
- Helmet, CORS allow-list, body limits, structured Pino logging, centralized errors
- Docker Compose for MongoDB, Redis, and the API
- OpenAPI UI at `/docs`

## Run locally

1. Copy `.env.example` to `.env` and replace the JWT secrets.
2. Start infrastructure: `docker compose up -d mongo redis`.
3. Install dependencies: `npm install`.
4. Seed initial data: `npm run seed`.
5. Start the API: `npm run dev`.

The API runs on `http://localhost:5000`; liveness is `/live`, readiness is `/ready`, and the API docs are `/docs`.

## Important production boundary

Razorpay, stock reservations, transactional order finalization, email, shipping, BullMQ workers, reviews, coupons, CMS, returns/refunds, reports, and admin management are intentionally separate implementation slices. Payment must not be enabled in production until server-side Razorpay signature/webhook verification and atomic inventory reservation are implemented.

See `docs/frontend-backend-contract.md` and `docs/implementation-roadmap.md` for the contract and delivery sequence.
