require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const roles = await prisma.roles.findMany({ select: { name: true, permissions: true } });
  console.log(JSON.stringify(roles, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
