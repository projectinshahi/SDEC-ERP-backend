import prisma from '../config/db.js';
import { io } from '../socket.js';

interface CreateNotificationParams {
  userId: number;
  type: 'assignment' | 'status_change' | 'escalation' | 'discussion' | 'mention' | 'attachment' | 'resolution' | 'reassignment' | string;
  title: string;
  message: string;
  entityType: 'blocker' | 'task' | 'bug' | string;
  entityId: number | string; // blockers use numeric IDs usually, but let's store it dynamically as Int, so blocker=Int. If it's a string ID, we might need a separate field or parse it. The schema uses Int for entity_id.
}

export const notificationService = {
  /**
   * Create a notification in the database and emit it via Socket.IO
   */
  async createNotification(data: CreateNotificationParams) {
    try {
      const entityIdNum = typeof data.entityId === 'string' ? parseInt(data.entityId, 10) : data.entityId;
      
      const notification = await prisma.notifications.create({
        data: {
          user_id: data.userId,
          type: data.type,
          title: data.title,
          message: data.message,
          entity_type: data.entityType,
          entity_id: isNaN(entityIdNum) ? 0 : entityIdNum,
          is_read: false,
        },
      });

      // Emit to specific user's socket room
      if (io) {
        console.log(`[NotificationService] Emitting new_notification to user_${data.userId}`);
        io.to(`user_${data.userId}`).emit('new_notification', notification);
      } else {
        console.error('[NotificationService] Socket IO is not initialized!');
      }

      return notification;
    } catch (error) {
      console.error('[NotificationService] Failed to create notification:', error);
      return null;
    }
  },

  /**
   * Batch create notifications for multiple users
   */
  async createNotifications(userIds: number[], data: Omit<CreateNotificationParams, 'userId'>) {
    // Dedup user IDs
    const uniqueUserIds = Array.from(new Set(userIds));
    
    const notifications = await Promise.all(
      uniqueUserIds.map(userId => this.createNotification({ ...data, userId }))
    );
    
    return notifications;
  }
};
