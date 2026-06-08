import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

export let io: Server;
import prisma from './config/db.js';

export const initSocket = (server: HttpServer) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Basic authentication for sockets using the existing dummy token system
  io.use((socket, next) => {
    let token = socket.handshake.auth.token || socket.handshake.headers.authorization;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      if (token.startsWith('Bearer ')) {
        token = token.slice(7);
      }
      
      const tokenParts = token.split('user-token-');
      if (tokenParts.length < 2) {
        console.error('[Socket] Invalid token format:', token);
        return next(new Error('Invalid token'));
      }
      
      const userId = parseInt(tokenParts[1], 10);
      if (isNaN(userId)) {
        console.error('[Socket] Invalid token ID:', token);
        return next(new Error('Invalid token ID'));
      }

      socket.data.user = { userId };
      console.log(`[Socket] Auth successful for user ${userId}`);
      next();
    } catch (err) {
      console.error('[Socket] Auth error:', err);
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.user?.userId;
    // console.log(`User connected to socket: ${userId}`);

    if (userId) {
      socket.join(`user_${userId}`);
    }

    // Join a specific board room
    socket.on('join_board_room', (data: { boardId: number }) => {
      if (!data.boardId) return;
      socket.join(`board_${data.boardId}`);
    });

    // Leave board room
    socket.on('leave_board_room', (data: { boardId: number }) => {
      if (!data.boardId) return;
      socket.leave(`board_${data.boardId}`);
    });

    // Join a specific task discussion room
    socket.on('join_task_room', (data: { taskId: string }) => {
      if (!data.taskId) return;
      socket.join(`task_${data.taskId}`);
      // Notify room that user is online (optional, can broadcast presence)
      socket.to(`task_${data.taskId}`).emit('user_online', { userId });
    });

    // Leave task discussion room
    socket.on('leave_task_room', (data: { taskId: string }) => {
      if (!data.taskId) return;
      socket.leave(`task_${data.taskId}`);
      socket.to(`task_${data.taskId}`).emit('user_offline', { userId });
    });

    // Typing indicator
    socket.on('typing', (data: { taskId: string, userName: string }) => {
      if (!data.taskId) return;
      socket.to(`task_${data.taskId}`).emit('typing', {
        userId,
        userName: data.userName
      });
    });

    // Stop typing indicator
    socket.on('stop_typing', (data: { taskId: string }) => {
      if (!data.taskId) return;
      socket.to(`task_${data.taskId}`).emit('stop_typing', { userId });
    });

    // --- BUG DISCUSSION ROOMS ---

    // Join a specific bug discussion room
    socket.on('join_bug_room', (data: { bugId: string }) => {
      if (!data.bugId) return;
      socket.join(`bug_${data.bugId}`);
      socket.to(`bug_${data.bugId}`).emit('user_online', { userId });
    });

    // Leave bug discussion room
    socket.on('leave_bug_room', (data: { bugId: string }) => {
      if (!data.bugId) return;
      socket.leave(`bug_${data.bugId}`);
      socket.to(`bug_${data.bugId}`).emit('user_offline', { userId });
    });

    // Typing indicator for bugs
    socket.on('bug_typing', (data: { bugId: string, userName: string }) => {
      if (!data.bugId) return;
      socket.to(`bug_${data.bugId}`).emit('typing', {
        userId,
        userName: data.userName
      });
    });

    // Stop typing indicator for bugs
    socket.on('stop_bug_typing', (data: { bugId: string }) => {
      if (!data.bugId) return;
      socket.to(`bug_${data.bugId}`).emit('stop_typing', { userId });
    });

    // --- BLOCKER DISCUSSION ROOMS ---

    // Join a specific blocker discussion room
    socket.on('join_blocker_room', async (data: { blockerId: string }) => {
      if (!data.blockerId) return;

      try {
        const blockerIdNum = parseInt(data.blockerId);
        if (isNaN(blockerIdNum)) return;

        // Fetch blocker to get projectId
        const blocker = await prisma.blocker.findUnique({
          where: { id: blockerIdNum },
          select: { projectId: true }
        });

        if (!blocker) {
          socket.emit('error', { message: 'Blocker not found' });
          return;
        }

        // Global admins skip membership check
        const user = await prisma.users.findUnique({
          where: { id: userId },
          select: { role: true }
        });
        const userRole = (user?.role || '').toLowerCase();
        const isGlobalAdmin = userRole === 'admin' || userRole === 'super admin';

        if (!isGlobalAdmin) {
          // Check if user is a member of the project
          const member = await prisma.project_members.findUnique({
            where: {
              project_id_user_id: { project_id: blocker.projectId, user_id: userId }
            }
          });

          if (!member) {
            socket.emit('error', { message: 'Unauthorized: You are not a member of this project' });
            return; // Reject join
          }
        }

        socket.join(`blocker_${data.blockerId}`);
        socket.to(`blocker_${data.blockerId}`).emit('user_online', { userId });
      } catch (error) {
        console.error('Error joining blocker room:', error);
      }
    });

    // Leave blocker discussion room
    socket.on('leave_blocker_room', (data: { blockerId: string }) => {
      if (!data.blockerId) return;
      socket.leave(`blocker_${data.blockerId}`);
      socket.to(`blocker_${data.blockerId}`).emit('user_offline', { userId });
    });

    // Typing indicator for blockers
    socket.on('blocker_typing', (data: { blockerId: string, userName: string }) => {
      if (!data.blockerId) return;
      socket.to(`blocker_${data.blockerId}`).emit('typing', {
        userId,
        userName: data.userName
      });
    });

    // Stop typing indicator for blockers
    socket.on('stop_blocker_typing', (data: { blockerId: string }) => {
      if (!data.blockerId) return;
      socket.to(`blocker_${data.blockerId}`).emit('stop_typing', { userId });
    });

    socket.on('disconnect', () => {
      // console.log(`User disconnected from socket: ${userId}`);
    });
  });

  return io;
};
