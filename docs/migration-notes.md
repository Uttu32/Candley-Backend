# Migration notes: backend hardening release

Run these steps once when deploying this version to an existing database.

1. **Deploy the code** with these environment changes:
   - Remove `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env`; they are no longer read.
   - Add `RAZORPAY_WEBHOOK_SECRET` if Razorpay keys are set (startup fails in production without it).
   - Optionally add the SMTP variables.
2. **Rotate the old default admin password.** The previous code shipped a default admin password in `src/config/env.ts`, and `fix-admin-password.mjs` (committed to git) contained a real admin email and password. Treat both as compromised:
   `npm run admin:create -- --email <admin email> --reset-password`
   Both remain in git history; rewrite history if the repository is or will be shared.
3. **Indexes and data:** `npm run db:sync-indexes` (dry run), then `npm run db:sync-indexes -- --apply`. This:
   - stops if duplicate emails, slugs or SKUs would block unique indexes, and lists them;
   - recreates `refreshtokens.expiresAt_1` as a TTL index (it previously conflicted with a plain index, so expired refresh tokens were never purged);
   - adds the new order, product and hero indexes and drops superseded single-field ones;
   - recomputes product-level `stock` as the sum of active variant stock for variant products.
4. **Existing carts** may contain duplicate lines for the same product. They still display and check out correctly (each line is validated), and new adds merge into a single line.
5. **Existing orders** keep their data. Older orders have no `variantLabel`/`productSlug` snapshot and no `statusHistory`.
