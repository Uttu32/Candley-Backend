import { v2 as cloudinary } from 'cloudinary'
import multer from 'multer'
import { env } from './env.js'
import { logger } from './logger.js'
import { ApiError } from '../utils/api-error.js'

export const isCloudinaryConfigured = () => Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET)

if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  })
}

export const mediaFolders = { products: 'candley-aroma/products', hero: 'candley-aroma/hero' } as const
type ResourceType = 'image' | 'video'

const imageMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
const videoMimeTypes = ['video/mp4', 'video/webm']

/** Detects the real file type from its leading bytes; the client-declared MIME type is not trusted. */
export const sniffMediaType = (buffer: Buffer): string | null => {
  if (buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    return 'video/mp4'
  }
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm'
  return null
}

const uploadFilter = (allowed: string[]): multer.Options['fileFilter'] => (_request, file, callback) => {
  if (allowed.includes(file.mimetype)) callback(null, true)
  else callback(new ApiError(415, `Unsupported file type. Allowed: ${allowed.join(', ')}`, [], 'UNSUPPORTED_MEDIA_TYPE'))
}

export const imageUpload = multer({ storage: multer.memoryStorage(), limits: { files: 12, fileSize: 8 * 1024 * 1024 }, fileFilter: uploadFilter(imageMimeTypes) })
/** Small videos may be proxied; larger ones should use a signed direct upload (see `createSignedUpload`). */
export const heroMediaUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 40 * 1024 * 1024 }, fileFilter: uploadFilter([...imageMimeTypes, ...videoMimeTypes]) })

export const assertFileContent = (file: Express.Multer.File, kind: ResourceType) => {
  const detected = sniffMediaType(file.buffer)
  const allowed = kind === 'image' ? imageMimeTypes : videoMimeTypes
  if (!detected || !allowed.includes(detected)) throw new ApiError(415, `File "${file.originalname}" is not a valid ${kind}`, [], 'UNSUPPORTED_MEDIA_TYPE')
}

const requireCloudinary = () => {
  if (!isCloudinaryConfigured()) throw new ApiError(503, 'Media storage is not configured', [], 'MEDIA_UNAVAILABLE')
}

export const uploadMedia = (buffer: Buffer, folder: string, resourceType: ResourceType = 'image') => {
  requireCloudinary()
  return new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const options = resourceType === 'image'
      ? { folder, resource_type: 'image' as const, transformation: [{ quality: 'auto', fetch_format: 'auto' }] }
      : { folder, resource_type: 'video' as const }
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error || !result) {
        logger.warn({ message: error?.message }, 'Cloudinary upload failed')
        reject(new ApiError(502, 'Media upload failed, please try again', [], 'MEDIA_UPLOAD_FAILED'))
        return
      }
      resolve({ secure_url: result.secure_url, public_id: result.public_id })
    })
    stream.end(buffer)
  })
}

export const uploadImage = (buffer: Buffer, folder: string) => uploadMedia(buffer, folder, 'image')

/**
 * Extracts the public id from a URL on this account's Cloudinary delivery domain, or null for any other URL.
 * Example: https://res.cloudinary.com/<cloud>/image/upload/v123/candley-aroma/hero/abc.jpg → candley-aroma/hero/abc
 */
export const parseCloudinaryUrl = (url: string): { publicId: string; resourceType: ResourceType } | null => {
  if (!env.CLOUDINARY_CLOUD_NAME) return null
  const prefix = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`
  if (!url.startsWith(prefix)) return null
  const match = /^(image|video)\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(candley-aroma\/.+)\.[a-z0-9]+$/i.exec(url.slice(prefix.length))
  return match ? { resourceType: match[1] as ResourceType, publicId: match[2]! } : null
}

/** Deletes replaced media. Failures are logged, never thrown: the content update has already succeeded. */
export const destroyMediaByUrl = async (url: string | null | undefined) => {
  if (!url || !isCloudinaryConfigured()) return
  const parsed = parseCloudinaryUrl(url)
  if (!parsed) return
  try {
    await cloudinary.uploader.destroy(parsed.publicId, { resource_type: parsed.resourceType, invalidate: true })
  } catch (error) {
    logger.warn({ publicId: parsed.publicId, message: error instanceof Error ? error.message : String(error) }, 'Failed to delete replaced media')
  }
}

/**
 * Signature for a browser-to-Cloudinary upload, so large videos never pass through the API.
 * The folder is fixed server-side and the signature expires with its timestamp (Cloudinary allows 1 hour).
 */
export const createSignedUpload = (folder: string, resourceType: ResourceType) => {
  requireCloudinary()
  const timestamp = Math.round(Date.now() / 1000)
  const params = { folder, timestamp }
  const signature = cloudinary.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET!)
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    folder,
    timestamp,
    signature,
    resourceType,
  }
}
