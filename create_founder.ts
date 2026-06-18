import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set in .env');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function hashPassword(plain: string) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

async function createFounder() {
  const email = 'founder@sdec.local';
  const name = 'Founder';

  // Check if founder already exists
  const existing = await prisma.$queryRawUnsafe<any[]>(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;',
    email
  );

  if (existing.length > 0) {
    console.log(`Founder account already exists (${email}).`);
    return;
  }

  // Generate secure temporary password
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const upperChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const nums = '0123456789';
  const specialChars = '!@#$%^&*';
  
  let generatedPassword = '';
  generatedPassword += chars[Math.floor(Math.random() * chars.length)];
  generatedPassword += upperChars[Math.floor(Math.random() * upperChars.length)];
  generatedPassword += nums[Math.floor(Math.random() * nums.length)];
  generatedPassword += specialChars[Math.floor(Math.random() * specialChars.length)];
  
  const allChars = chars + upperChars + nums + specialChars;
  for (let i = generatedPassword.length; i < 12; i++) {
    generatedPassword += allChars[Math.floor(Math.random() * allChars.length)];
  }
  generatedPassword = generatedPassword.split('').sort(() => 0.5 - Math.random()).join('');

  const hashedPassword = hashPassword(generatedPassword);

  await prisma.$executeRawUnsafe(
    'INSERT INTO users (name, email, password, role, status, must_change_password) VALUES ($1, $2, $3, $4, $5, $6);',
    name,
    email,
    hashedPassword,
    'SuperAdmin',
    'active',
    true
  );

  console.log(`\n✅ Founder account created successfully!`);
  console.log(`----------------------------------------`);
  console.log(`Email:    ${email}`);
  console.log(`Password: ${generatedPassword}`);
  console.log(`----------------------------------------`);
  console.log(`Please login and change your password.\n`);

  await prisma.$disconnect();
}

createFounder().catch((err) => {
  console.error('Error creating founder:', err);
  prisma.$disconnect();
  process.exit(1);
});
