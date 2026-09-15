import { Schema, model } from 'mongoose'

export type UserRole = 'CUSTOMER' | 'STAFF' | 'ADMIN' | 'SUPER_ADMIN'

const userSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  phone: { type: String, trim: true },
  dateOfBirth: { type: String },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['CUSTOMER', 'STAFF', 'ADMIN', 'SUPER_ADMIN'], default: 'CUSTOMER' },
  status: { type: String, enum: ['ACTIVE', 'BLOCKED', 'SUSPENDED', 'DELETED'], default: 'ACTIVE' },
  emailVerified: { type: Boolean, default: false },
  lastLoginAt: Date,
}, { timestamps: true })

export const User = model('User', userSchema)
