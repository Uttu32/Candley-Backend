import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'

export type UserRole = 'CUSTOMER' | 'STAFF' | 'ADMIN' | 'SUPER_ADMIN'
export const userRoles = ['CUSTOMER', 'STAFF', 'ADMIN', 'SUPER_ADMIN'] as const
export const adminRoles = ['ADMIN', 'SUPER_ADMIN'] as const

export const addressSchema = new Schema({
  label: { type: String, trim: true, default: 'Home' },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  addressLine1: { type: String, required: true, trim: true },
  addressLine2: { type: String, trim: true, default: '' },
  city: { type: String, required: true, trim: true },
  state: { type: String, required: true, trim: true },
  postalCode: { type: String, required: true, trim: true },
  country: { type: String, required: true, trim: true, default: 'India' },
  isDefault: { type: Boolean, default: false },
}, { _id: true, timestamps: true })

const userSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  dateOfBirth: { type: String },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: userRoles, default: 'CUSTOMER' },
  status: { type: String, enum: ['ACTIVE', 'BLOCKED', 'SUSPENDED', 'DELETED'], default: 'ACTIVE' },
  emailVerified: { type: Boolean, default: false },
  addresses: { type: [addressSchema], default: [] },
  /** Incremented on password change/reset; access tokens carrying an older version are rejected. */
  tokenVersion: { type: Number, default: 0 },
  passwordResetTokenHash: { type: String, select: false },
  passwordResetExpiresAt: { type: Date, select: false },
  lastLoginAt: Date,
}, { timestamps: true })

userSchema.index({ role: 1, createdAt: -1 })

export type UserDocument = HydratedDocument<InferSchemaType<typeof userSchema>>
export const User = model('User', userSchema)

/** Public projection of an account. Never includes secrets. */
export const toPublicUser = (user: { _id: unknown; name: string; email: string; role: string; phone?: string | null; dateOfBirth?: string | null; emailVerified?: boolean | null }) => {
  const id = String(user._id)
  return {
    id,
    _id: id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? '',
    dateOfBirth: user.dateOfBirth ?? '',
    role: user.role as UserRole,
    emailVerified: Boolean(user.emailVerified),
  }
}
