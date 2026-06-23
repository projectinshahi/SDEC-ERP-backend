require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const crypto = require('crypto');

function hashPassword(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

async function configureFounderForDb(dbName, connectionString, email, name, hashedPassword) {
  if (!connectionString) {
    console.log(`[Script] Skipping ${dbName} Database: Connection string not provided.`);
    return;
  }
  
  console.log(`[Script] Configuring founder on ${dbName} Database...`);
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const existing = await prisma.$queryRawUnsafe(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1;',
      email
    );

    if (existing.length > 0) {
      console.log(`[${dbName}] Founder account exists. Regenerating password...`);
      await prisma.$executeRawUnsafe(
        'UPDATE users SET password = $1, must_change_password = $2 WHERE LOWER(email) = LOWER($3);',
        hashedPassword,
        false, // Explicitly false so you can login directly without 403 on Dashboard
        email
      );
    } else {
      console.log(`[${dbName}] Creating new Founder account...`);
      await prisma.$executeRawUnsafe(
        'INSERT INTO users (name, email, password, role, status, must_change_password) VALUES ($1, $2, $3, $4, $5, $6);',
        name,
        email,
        hashedPassword,
        'SuperAdmin',
        'active',
        false
      );
    }
    console.log(`[${dbName}] ✅ Done.`);
  } catch (error) {
    console.error(`[${dbName}] ❌ Error:`, error.message);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

async function createFounder() {
  const email = 'founder@sdec.local';
  const name = 'Founder';

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

  // Configure for BOTH databases
  await configureFounderForDb('Development (Testing)', process.env.DATABASE_URL_DEV, email, name, hashedPassword);
  await configureFounderForDb('Production', process.env.DATABASE_URL_PROD, email, name, hashedPassword);

  console.log(`\n✅ Founder account configured successfully!`);
  console.log(`----------------------------------------`);
  console.log(`Email:    ${email}`);
  console.log(`Password: ${generatedPassword}`);
  console.log(`----------------------------------------`);
  console.log(`You can now login to both environments with these credentials.\n`);
}

createFounder().catch((err) => {
  console.error('Error in script:', err);
  process.exit(1);
});
