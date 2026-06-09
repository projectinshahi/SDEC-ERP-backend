require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  await prisma.users.create({
    data: { name: 'Admin User', email: 'admin@sdec.com', password: 'admin123', role: 'Super Admin', status: 'Active' }
  });
  console.log('Admin inserted successfully!');
}
main().catch(console.error).finally(() => prisma.$disconnect());
