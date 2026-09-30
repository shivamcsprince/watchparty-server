import { z } from 'zod';

// bcrypt only reads the first 72 BYTES of a password, so we reject longer ones
// instead of silently ignoring the rest.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password is too long (max 72 bytes)');

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address')),
  username: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9_]{3,20}$/,
      'Username must be 3-20 characters: letters, numbers and underscores only',
    ),
  password,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});
