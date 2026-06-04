import 'dotenv/config';

import app from './app.js';
import prisma from './config/db.js';
import { initDb } from './config/initDb.js';
import { verifySMTPConnection } from './services/email.service.js';
import { initSocket } from './socket.js';

const DEFAULT_PORT = 3001;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || String(DEFAULT_PORT), 10);

const startServer = async () => {
  try {
    // Test the database connection
    await prisma.$connect();
    console.log('✅ Successfully connected to the Neon PostgreSQL database');

    // Run schema updates & data seeding dynamically
    await initDb();

    // Verify SMTP connection (non-blocking — server starts even if SMTP fails)
    verifySMTPConnection().catch(() => {});

    const server = app.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`);
    });

    // Initialize Socket.io
    initSocket(server);

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Set PORT to another free port or stop the conflicting process.`);
        process.exit(1);
      }
      console.error('❌ Server error:', error);
      process.exit(1);
    });
  } catch (error) {
    console.error('❌ Failed to connect to the database. Error:', error);
    process.exit(1);
  }
};

startServer();
