import mongoose from 'mongoose';
import argon2 from 'argon2';
import { env } from './src/config/env.ts';

const email = 'utkarshksharm7878@gmail.com';
const password = 'Admin@123#';

try {
  await mongoose.connect(env.MONGO_URI);

  const User = mongoose.models.User ?? mongoose.model('User', new mongoose.Schema({
    name: String,
    email: { type: String, lowercase: true },
    passwordHash: String,
    role: String,
    emailVerified: Boolean,
    status: String,
  }, { collection: 'users' }));

  const hash = await argon2.hash(password);
  const user = await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    { $set: { name: 'Admin User', passwordHash: hash, role: 'SUPER_ADMIN', emailVerified: true, status: 'ACTIVE' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const passwordMatch = await argon2.verify(hash, password);
  console.log('updatedUser:', user?.email, user?.role, user?.status);
  console.log('passwordMatch:', passwordMatch);

  await mongoose.disconnect();
} catch (error) {
  console.error('Fix admin password failed:', error);
  process.exit(1);
}
