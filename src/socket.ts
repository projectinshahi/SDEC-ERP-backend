import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

export let io: Server;

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
        return next(new Error('Invalid token'));
      }
      
      const userId = parseInt(tokenParts[1], 10);
      if (isNaN(userId)) {
        return next(new Error('Invalid token ID'));
      }

      socket.data.user = { userId };
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.user?.userId;
    // console.log(`User connected to socket: ${userId}`);

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

    socket.on('disconnect', () => {
      // console.log(`User disconnected from socket: ${userId}`);
    });
  });

  return io;
};
