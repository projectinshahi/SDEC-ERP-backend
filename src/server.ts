import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import prisma from './config/db';
import { initDb } from './config/initDb';

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // Test the database connection
    await prisma.$connect();
    console.log('✅ Successfully connected to the Neon PostgreSQL database');

    // Run schema updates & data seeding dynamically
    await initDb();

    app.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to connect to the database. Error:', error);
    process.exit(1);
  }
};

startServer();
