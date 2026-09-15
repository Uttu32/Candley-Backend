import { Schema, model } from 'mongoose'

const heroSlideSchema = new Schema({
  heading: { type: String, required: true, trim: true },
  subheading: { type: String, required: true, trim: true },
  ctaText: { type: String, default: 'Shop now' },
  ctaUrl: { type: String, default: '/shop' },
  desktopImage: { type: String, default: '' },
  mobileImage: { type: String, default: '' },
  backgroundVideo: { type: String, default: '' },
  overlayPosition: { type: String, default: 'center-left' },
  textAlignment: { type: String, default: 'left' },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true })

export const HeroSlide = model('HeroSlide', heroSlideSchema)
