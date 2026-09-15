import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export type AccessClaims = { sub: string; role: string; type: 'access' }
export type RefreshClaims = { sub: string; type: 'refresh'; jti: string }

export const signAccessToken = (claims: Omit<AccessClaims, 'type'>) => jwt.sign({ ...claims, type: 'access' }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'] })
export const signRefreshToken = (claims: Omit<RefreshClaims, 'type'>) => jwt.sign({ ...claims, type: 'refresh' }, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'] })
export const verifyAccessToken = (token: string) => jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims
export const verifyRefreshToken = (token: string) => jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshClaims
