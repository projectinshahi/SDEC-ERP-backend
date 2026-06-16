import 'dotenv/config';

import app from './app.js';
import prisma from './config/db.js';
import { initDb } from './config/initDb.js';
import { verifySMTPConnection } from './services/email.service.js';
import { leadReminderService } from './services/leadReminder.service.js';
import { dealEventService } from './services/dealEvent.service.js';
import { initSocket } from './socket.js';

const DEFAULT_PORT = 3001;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || String(DEFAULT_PORT), 10);

// Periodic scan for due/overdue follow-up reminders → notifications (no external
// scheduler dependency). Reminders are also scanned on-demand when an owner
// loads their dashboard widget.
const REMINDER_SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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

    // Periodic background sweep: due/overdue follow-up reminders, deal close-date
    // reminders, and retry of any pending Deal Won events. No external scheduler.
    const sweep = () => {
      leadReminderService.scanDueReminders().catch(() => {});
      dealEventService.scanDealCloseDeadlines().catch(() => {});
      dealEventService.processPendingDealWonEvents().catch(() => {});
    };
    setTimeout(sweep, 15_000);
    setInterval(sweep, REMINDER_SCAN_INTERVAL_MS);

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
