# Redis architecture

Redis is currently used as a shared connectivity/readiness dependency. The next slice will add:

- cache-aside product/category/homepage reads with bounded TTLs
- distributed rate limiting for auth, checkout, and payment endpoints
- BullMQ queues for email, notifications, order/inventory expiry, analytics, and reports
- locks only for operations that cannot be made atomic in MongoDB

Redis outages must not turn stale cache data into successful payments or orders. MongoDB remains the source of truth for transactional state.
