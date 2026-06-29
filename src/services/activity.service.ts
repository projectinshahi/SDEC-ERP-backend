import prisma from '../config/db.js';
import { notificationService } from './notification.service.js';

interface LogActivityParams {
  actorUserId: number;
  targetUserId?: number;
  projectId?: string;
  taskId?: string;
  blockerId?: number;
  ticketId?: number;
  leadId?: number;
  dealId?: number;
  type: string;
  description: string;
}

export const activityService = {
  /**
   * Logs a single activity to the activity_logs table
   */
  async logActivity(data: LogActivityParams) {
    try {
      await prisma.activity_logs.create({
        data: {
          actor_user_id: data.actorUserId,
          target_user_id: data.targetUserId,
          project_id: data.projectId,
          task_id: data.taskId,
          blocker_id: data.blockerId,
          ticket_id: data.ticketId,
          lead_id: data.leadId,
          deal_id: data.dealId,
          type: data.type,
          description: data.description,
        },
      });
    } catch (error) {
      console.error('Failed to log activity:', error);
    }
  },

  /**
   * Parses a text (e.g. task description) for @mentions and logs an activity for each matched user.
   */
  async extractAndLogMentions(
    text: string,
    actorUserId: number,
    projectId?: string,
    taskId?: string,
    contextTitle?: string
  ) {
    if (!text) return;

    // Regex to match @Word or @Name. Note: This simple regex matches @ followed by letters/numbers.
    const mentionRegex = /@([a-zA-Z0-9_]+)/g;
    const matches = [...text.matchAll(mentionRegex)];

    if (matches.length === 0) return;

    const uniqueMentions = Array.from(new Set(matches.map((m) => m[1])));

    try {
      // Find users whose name contains the mentioned text (case-insensitive for robust matching)
      // Or we can try exact matching. Let's do a loose matching where the name starts with the mention.

      const mentionedUsers = await prisma.users.findMany({
        where: {
          OR: uniqueMentions.map(name => ({
            name: {
              contains: name,
              mode: 'insensitive'
            }
          }))
        },
        select: { id: true, name: true }
      });

      // Filter to just the exact/close matches to avoid false positives from `contains`
      const exactishMatches = mentionedUsers.filter((u: any) =>
        uniqueMentions.some((m: any) => u.name?.toLowerCase().includes(m.toLowerCase()))
      );

      for (const user of exactishMatches) {
        // Prevent mentioning oneself
        if (user.id === actorUserId) continue;

        const actor = await prisma.users.findUnique({ where: { id: actorUserId } });

        await this.logActivity({
          actorUserId,
          targetUserId: user.id,
          projectId,
          taskId,
          type: 'mention',
          description: `${actor?.name || 'Someone'} mentioned you in '${contextTitle || 'a discussion'}'`,
        });

        // Generate a notification if the context is a blocker (extract blocker ID from contextTitle if possible, or use a generic notification)
        let entityType = 'discussion';
        let entityId = 0;

        if (contextTitle?.toLowerCase().includes('blocker #')) {
          const match = contextTitle.match(/blocker #(\d+)/i);
          if (match && match[1]) {
            entityType = 'blocker';
            entityId = parseInt(match[1], 10);
          }
        }

        await notificationService.createNotification({
          userId: user.id,
          type: 'mention',
          title: 'You were mentioned',
          message: `${actor?.name || 'Someone'} mentioned you in '${contextTitle || 'a discussion'}'`,
          entityType,
          entityId
        });
      }
    } catch (error) {
      console.error('Error processing mentions:', error);
    }
  }
};
