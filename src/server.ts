import 'dotenv/config';

import app from './app.js';
import prisma from './config/db.js';
import { initDb } from './config/initDb.js';
import { verifySMTPConnection } from './services/email.service.js';
import { leadReminderService } from './services/leadReminder.service.js';
import { dealEventService } from './services/dealEvent.service.js';
import { stalledDealService } from './services/stalledDeal.service.js';
import { salesTaskService } from './services/salesTask.service.js';
import { recurringTaskService } from './services/recurringTask.service.js';
import { salesReportService } from './services/salesReport.service.js';
import { initSocket } from './socket.js';

const DEFAULT_PORT = 3001;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || String(DEFAULT_PORT), 10);

// Periodic scan for due/overdue follow-up reminders → notifications (no external
// scheduler dependency). Reminders are also scanned on-demand when an owner
// loads their dashboard widget.
const REMINDER_SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const startServer = async () => {
  console.log('🔄 Watcher triggered server reload...');
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
    // reminders, retry of any pending Deal Won events, and stalled-deal detection
    // + alerts (SE-021). No external scheduler.
    const sweep = () => {
      leadReminderService.scanDueReminders().catch(() => {});
      dealEventService.scanDealCloseDeadlines().catch(() => {});
      dealEventService.processPendingDealWonEvents().catch(() => {});
      stalledDealService.scanStalledDeals().catch(() => {});
      // SE-029.1 overdue task alerts + SE-027.1 recurring task generation.
      salesTaskService.scanOverdueTasks().catch(() => {});
      recurringTaskService.generateDueRecurringTasks().catch(() => {});
      // SE-030 daily report aggregation (once/day, self-guarded) + scheduler.
      salesReportService.runDailyAggregation().catch(() => {});
      salesReportService.processDueSchedules().catch(() => {});
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
