import { Schema, model } from 'mongoose'

/** Singleton document holding checkout configuration. Defaults match the previous hardcoded behaviour. */
const storeSettingsSchema = new Schema({
  shippingFee: { type: Number, default: 99, min: 0 },
  freeShippingThreshold: { type: Number, default: 999, min: 0 },
  codEnabled: { type: Boolean, default: true },
  /** Orders above this total cannot use COD. Unset means no limit. */
  codMaxOrderValue: { type: Number, min: 0 },
  maxQuantityPerItem: { type: Number, default: 10, min: 1, max: 99 },
}, { timestamps: true })

export const StoreSettings = model('StoreSettings', storeSettingsSchema)

export const getStoreSettings = async () => {
  const existing = await StoreSettings.findOne().lean()
  if (existing) return existing
  return (await StoreSettings.findOneAndUpdate({}, { $setOnInsert: {} }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean())!
}
