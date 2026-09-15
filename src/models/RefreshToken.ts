import { Schema, model } from 'mongoose'

const refreshTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenId: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true })
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
export const RefreshToken = model('RefreshToken', refreshTokenSchema)
