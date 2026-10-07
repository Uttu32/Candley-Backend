import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

/** `role` is informational for clients; the server re-reads role and status from the database on each request. */
export type AccessClaims = { sub: string; role: string; ver: number; type: 'access' }
export type RefreshClaims = { sub: string; type: 'refresh'; jti: string }

export const signAccessToken = (claims: Omit<AccessClaims, 'type'>) => jwt.sign({ ...claims, type: 'access' }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'] })
export const signRefreshToken = (claims: Omit<RefreshClaims, 'type'>) => jwt.sign({ ...claims, type: 'refresh' }, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'] })

export const verifyAccessToken = (token: string) => {
  const claims = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessClaims
  if (claims.type !== 'access') throw new Error('Wrong token type')
  return claims
}

export const verifyRefreshToken = (token: string) => {
  const claims = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as RefreshClaims
  if (claims.type !== 'refresh') throw new Error('Wrong token type')
  return claims
}

/** Lifetime of the refresh JWT in milliseconds, derived from the same setting used to sign it. */
export const refreshTokenTtlMs = () => {
  const decoded = jwt.decode(signRefreshToken({ sub: 'ttl', jti: 'ttl' })) as { iat: number; exp: number }
  return (decoded.exp - decoded.iat) * 1000
}

export const createOpaqueToken = () => randomBytes(32).toString('hex')
export const hashOpaqueToken = (token: string) => createHash('sha256').update(token).digest('hex')
