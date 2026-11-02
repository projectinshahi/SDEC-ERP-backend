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

// Neon closes idle connections (and suspends the compute when idle), so a pooled
// connection left idle can be dead by the next request → that request 500s.
// Drop idle clients early, keep live ones alive, and fail fast instead of hanging.
const pool = new Pool({
  connectionString: finalConnectionString,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
  connectionTimeoutMillis: 15_000, // a suspended Neon compute takes a few seconds to wake
});
// An idle client dropped by the server emits 'error' on the pool; unhandled, it crashes Node.
pool.on('error', (err) => console.error('[DB] Idle connection error (will reconnect):', err.message));
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export default prisma;
