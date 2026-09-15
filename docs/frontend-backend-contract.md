# Frontend-backend contract

The frontend currently uses mock data and local Zustand state. These endpoints are the first integration contract and preserve the existing route behavior without changing the UI shape unnecessarily.

| Frontend surface | Method | Endpoint | Auth | Request | Response data |
|---|---|---|---|---|---|
| Login form | POST | `/api/v1/auth/login` | No | `{ email, password }` | `{ accessToken, user }`, refresh cookie |
| Register form | POST | `/api/v1/auth/register` | No | `{ name, email, password }` | created user |
| Session refresh | POST | `/api/v1/auth/refresh` | Refresh cookie | none | `{ accessToken }` |
| Logout | POST | `/api/v1/auth/logout` | Refresh cookie | none | `null` |
| Shop/search/filter | GET | `/api/v1/products` | No | `q`, `category`, `collection`, `maxPrice`, `sort`, `page`, `limit` | `{ items, pagination }` |
| Product detail | GET | `/api/v1/products/:slug` | No | none | product matching current `Product` fields |
| Categories | GET | `/api/v1/products/categories` | No | none | category list |
| Cart load | GET | `/api/v1/cart` | Access token | none | cart with populated products |
| Add cart item | POST | `/api/v1/cart/items` | Access token | `{ productId, variantId?, quantity }` | updated cart |
| Update cart item | PATCH | `/api/v1/cart/items/:productId` | Access token | `{ quantity }` | updated cart |
| Remove cart item | DELETE | `/api/v1/cart/items/:productId` | Access token | none | updated cart |
| Wishlist load | GET | `/api/v1/wishlist` | Access token | none | wishlist with populated products |
| Wishlist add | POST | `/api/v1/wishlist` | Access token | `{ productId }` | updated wishlist |
| Wishlist remove | DELETE | `/api/v1/wishlist/:productId` | Access token | none | updated wishlist |
| Account orders | GET | `/api/v1/orders` | Access token | none | order list |
| Order detail | GET | `/api/v1/orders/:id` | Access token | none | order |
| Checkout | POST | `/api/v1/orders` | Access token | `{ shippingAddress, paymentMethod }` | server-calculated order |
| Service readiness | GET | `/ready` | No | none | Mongo/Redis status |

All responses use `{ success, message, data }` on success and `{ success, message, errors }` on errors. Prices, stock, tax, shipping, discounts, and payment state are server-owned.

## Integration flow

```text
React page -> API client -> /api/v1 route -> validation -> service/model -> MongoDB
                                                        \-> Redis/cache/jobs where appropriate
```

## Known frontend gaps

- Auth, checkout, and admin forms currently render inputs but do not submit.
- Cart and wishlist currently use local Zustand state and mock products.
- Razorpay is not yet wired in the frontend.
- Account orders and admin metrics/products are currently placeholders.
