# Database schema (initial slice)

- `User`: customer/admin identity, role, status, password hash excluded by default.
- `RefreshToken`: one rotated token identifier per session, TTL indexed by expiry.
- `Product`: storefront fields matching the frontend `Product` type, variants, searchable text index, active status.
- `Category`: slug, image, active state, sort order.
- `Cart`: one authenticated cart per user; product references and quantities.
- `Order`: immutable line-item price/name/SKU/image snapshots, address snapshot, calculated totals, payment and fulfilment state.

Future collections are intentionally separated by bounded context: inventory transactions/reservations, payments, coupons, reviews, returns/refunds, CMS, notifications, audit logs, and analytics events.
