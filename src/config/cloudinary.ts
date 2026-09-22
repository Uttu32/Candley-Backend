import { v2 as cloudinary } from 'cloudinary'
import { env } from './env.js'

const hasCloudinaryConfig = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET)

if (hasCloudinaryConfig) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  })
}

export const uploadImage = (buffer: Buffer, folder: string) => {
  if (!hasCloudinaryConfig) throw new Error('Cloudinary is not configured')
  return new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('Cloudinary upload failed'))
          return
        }
        resolve({ secure_url: result.secure_url, public_id: result.public_id })
      },
    )
    stream.end(buffer)
  })
}