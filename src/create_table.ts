import dotenv from 'dotenv';
dotenv.config();
import prisma from './config/db.js';

async function main() {
  console.log("Creating roles table if not exists...");
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        permissions JSONB DEFAULT '[]'::jsonb,
        "createdAt" TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("SUCCESS: roles table is ready.");
  } catch (err) {
    console.error("ERROR creating roles table:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
