import { Schema, model } from 'mongoose'

const announcementSchema = new Schema({
  enabled: { type: Boolean, default: false },
  message: { type: String, default: 'Free shipping on eligible orders' },
  freeShippingEnabled: { type: Boolean, default: true },
  freeShippingThreshold: { type: Number, default: 1999, min: 0 },
  dismissible: { type: Boolean, default: false },
  ctaText: { type: String },
  ctaUrl: { type: String },
}, { timestamps: true })

export const Announcement = model('Announcement', announcementSchema)
