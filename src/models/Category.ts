import { Schema, model } from 'mongoose'

const categorySchema = new Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  image: String,
  description: String,
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true })

export const Category = model('Category', categorySchema)
