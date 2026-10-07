import { Schema, model, type InferSchemaType } from 'mongoose'

export const overlayPositions = ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const
export const textAlignments = ['left', 'center', 'right'] as const

const ctaSchema = new Schema({
  text: { type: String, trim: true },
  url: { type: String, trim: true },
}, { _id: false })

/**
 * Field names `heading`, `subheading`, `ctaText`, `ctaUrl`, `desktopImage`, `mobileImage`,
 * `overlayPosition`, `textAlignment`, `active`, `sortOrder` are the existing frontend contract.
 */
const heroSlideSchema = new Schema({
  heading: { type: String, required: true, trim: true },
  subheading: { type: String, default: '', trim: true },
  ctaText: { type: String, default: 'Shop now' },
  ctaUrl: { type: String, default: '/shop' },
  secondaryCta: { type: ctaSchema, default: undefined },
  desktopImage: { type: String, default: '' },
  mobileImage: { type: String, default: '' },
  imageAlt: { type: String, default: '', trim: true },
  /** Legacy single video source, kept for compatibility; equals `desktopVideo` when set via the new fields. */
  backgroundVideo: { type: String, default: '' },
  desktopVideo: { type: String, default: '' },
  mobileVideo: { type: String, default: '' },
  posterImage: { type: String, default: '' },
  overlayPosition: { type: String, enum: overlayPositions, default: 'center-left' },
  textAlignment: { type: String, enum: textAlignments, default: 'left' },
  overlay: {
    color: { type: String, default: '#000000' },
    opacity: { type: Number, default: 0.35, min: 0, max: 1 },
  },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  startsAt: { type: Date },
  endsAt: { type: Date },
}, { timestamps: true })

heroSlideSchema.index({ active: 1, sortOrder: 1, createdAt: 1 })

export type HeroSlideShape = InferSchemaType<typeof heroSlideSchema>
export const HeroSlide = model('HeroSlide', heroSlideSchema)
