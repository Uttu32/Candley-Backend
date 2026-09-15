import type { AccessClaims } from '../utils/tokens.js'

declare global {
  namespace Express {
    interface Request {
      auth?: AccessClaims
    }
  }
}

export {}
