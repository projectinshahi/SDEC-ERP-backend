import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// Determine which database URL to use based on the environment
const isProd = process.env.NODE_ENV === 'production';
const connectionString = isProd ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL_DEV;

if (!connectionString) {
  console.warn(`[DB] Warning: ${isProd ? 'DATABASE_URL_PROD' : 'DATABASE_URL_DEV'} is not set in environment variables. Falling back to default DATABASE_URL.`);
} else {
  console.log(`[DB] Connecting to ${isProd ? 'Production' : 'Development (Testing)'} Database...`);
}

// Fallback to regular DATABASE_URL if the specific ones aren't set
const finalConnectionString = connectionString || process.env.DATABASE_URL;

const pool = new Pool({ connectionString: finalConnectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export default prisma;
