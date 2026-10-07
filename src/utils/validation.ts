import { z } from 'zod'
import { ApiError } from './api-error.js'

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier')
export const slugSchema = z.string().min(1).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug')

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export const paginate = (page: number, limit: number, total: number) => ({ page, limit, total, totalPages: Math.ceil(total / limit) })

/** Escapes user text so it can be embedded in a RegExp literally. */
export const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Parses a JSON string sent inside multipart form data, turning malformed input into a 400. */
export const parseJsonField = (value: unknown, field: string): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new ApiError(400, `Field "${field}" must be valid JSON`, [], 'VALIDATION_ERROR')
  }
}

/**
 * Links stored on CMS content: a site-relative path ("/shop") or an absolute https URL.
 * Rejects protocol-relative ("//evil.com"), javascript:, data: and other schemes.
 */
export const safeLinkSchema = z.string().trim().max(500).refine((value) => {
  if (value.startsWith('/')) return !value.startsWith('//') && !value.includes('\\')
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}, 'Must be a site path starting with "/" or an https:// URL')

/** Media references: an https URL or a site-relative asset path. */
export const mediaUrlSchema = safeLinkSchema
