import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

export let io: Server;
import prisma from './config/db.js';
import { canAccessMyTask } from './utils/myTaskAccess.js';
import { canJoinTaskRoom, canJoinBugRoom } from './utils/roomAccess.js';
import { verifyToken } from './utils/authToken.js';

// A single verdict per room type. The wording deliberately says nothing about
// whether the resource exists, and starts with "Unauthorized" so the existing
// client handler (MyTaskChat matches /unauthor/i) renders a denied state.
const TASK_ROOM_DENIED = 'Unauthorized: you do not have access to this task';
const BUG_ROOM_DENIED = 'Unauthorized: you do not have access to this bug';

// Allowed browser origins for the Socket.IO handshake. The handshake starts with
// an HTTP (xhr) poll, so its Access-Control-Allow-Origin MUST match the browser's
// real origin or the browser discards the response as an "xhr poll error".
// Configure CORS_ORIGINS (comma-separated) or FRONTEND_URL in production.
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const isDev = process.env.NODE_ENV !== 'production';

// cors() origin callback: reflect the request origin when allowed (keeps
// credentials:true valid — a wildcard "*" is illegal with credentials).
const corsOrigin = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
  if (!origin) return cb(null, true); // non-browser clients (curl, SSR) send no Origin
  if (allowedOrigins.includes(origin)) return cb(null, true);
  // In development accept any localhost/127.0.0.1 port so Next's port fallback
  // (3000 → 3001 → 3002 …) never breaks the socket handshake.
  if (isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
  return cb(new Error(`Origin ${origin} not allowed by CORS`), false);
};

export const initSocket = (server: HttpServer) => {
  io = new Server(server, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Socket identity uses the SAME signed-token verification as REST. Securing
  // one and not the other would just move the forgery to the other door: every
  // socket joins `user_<id>` and task/board rooms purely on this identity.
  io.use(async (socket, next) => {
    let token = socket.handshake.auth.token || socket.handshake.headers.authorization;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      if (typeof token !== 'string') {
        return next(new Error('Authentication error'));
      }
      if (token.startsWith('Bearer ')) {
        token = token.slice(7).trim();
      }

      const claims = verifyToken(token);
      if (!claims) {
        // Never log the token itself — it is a live credential.
        console.warn('[Socket] Rejected connection: invalid or expired token');
        return next(new Error('Authentication error'));
      }

      // Parity with REST: a signature alone is not enough. A deleted or
      // deactivated account must not hold a live socket until its token expires.
      //
      // A DB *failure* is treated differently from a DB *answer*. Identity is
      // already cryptographically proven by this point, so a transient outage
      // must not deny the connection: Socket.IO treats a middleware error as
      // terminal, so a blip would drop realtime until the app is restarted.
      // Only an affirmative "missing or inactive" rejects.
      try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
          'SELECT id, status FROM users WHERE id = $1 LIMIT 1;',
          claims.userId,
        );
        if (rows.length === 0 || String(rows[0].status).toLowerCase() === 'inactive') {
          console.warn(`[Socket] Rejected connection for user ${claims.userId}: no longer active`);
          return next(new Error('Authentication error'));
        }
      } catch (dbError) {
        console.error('[Socket] Active-user check unavailable; allowing a cryptographically verified identity:', dbError);
      }

      socket.data.user = { userId: claims.userId };
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

    // Join a specific project room
    socket.on('join_project_room', (data: { projectId: string }) => {
      if (!data.projectId) return;
      socket.join(`project_${data.projectId}`);
    });

    // Leave project room
    socket.on('leave_project_room', (data: { projectId: string }) => {
      if (!data.projectId) return;
      socket.leave(`project_${data.projectId}`);
    });

    // Join a specific task discussion room.
    // Authorization runs to completion BEFORE join(), so there is no window in
    // which an unauthorized socket is a member of the room. Reuses the REST
    // rule for kanban tasks (`task.read`) — see utils/roomAccess.
    socket.on('join_task_room', async (data: { taskId: string }) => {
      const taskId = data?.taskId;
      if (taskId === undefined || taskId === null || taskId === '') return;
      try {
        const access = await canJoinTaskRoom(taskId, Number(userId));
        if (!access.allowed) {
          // One verdict for every failure — missing permission, unknown task and
          // malformed id are indistinguishable, so a join cannot be used to probe
          // which task ids exist.
          socket.emit('error', { message: TASK_ROOM_DENIED });
          return;
        }
        socket.join(`task_${taskId}`);
        // Notify room that user is online (optional, can broadcast presence)
        socket.to(`task_${taskId}`).emit('user_online', { userId });
      } catch (error) {
        // Fail CLOSED: a lookup that throws must never fall through to a join.
        console.error('Error joining task room:', error);
        socket.emit('error', { message: TASK_ROOM_DENIED });
      }
    });

    // Leave task discussion room
    socket.on('leave_task_room', (data: { taskId: string }) => {
      if (!data.taskId) return;
      // Only a member can announce leaving; otherwise any socket could inject a
      // user_offline for itself into a room it was never authorized to enter.
      if (!socket.rooms.has(`task_${data.taskId}`)) return;
      socket.leave(`task_${data.taskId}`);
      socket.to(`task_${data.taskId}`).emit('user_offline', { userId });
    });

    // Typing indicator. Membership is now proof of authorization, so gating on
    // it keeps non-members from injecting presence into someone else's room.
    socket.on('typing', (data: { taskId: string, userName: string }) => {
      if (!data.taskId) return;
      if (!socket.rooms.has(`task_${data.taskId}`)) return;
      socket.to(`task_${data.taskId}`).emit('typing', {
        userId,
        userName: data.userName
      });
    });

    // Stop typing indicator
    socket.on('stop_typing', (data: { taskId: string }) => {
      if (!data.taskId) return;
      if (!socket.rooms.has(`task_${data.taskId}`)) return;
      socket.to(`task_${data.taskId}`).emit('stop_typing', { userId });
    });

    // --- BUG DISCUSSION ROOMS ---

    // Join a specific bug discussion room. Bugs carry their OWN rule —
    // `bugs.read`, the permission the REST bug routes require — which is not
    // assumed to be the same as the task rule.
    socket.on('join_bug_room', async (data: { bugId: string }) => {
      const bugId = data?.bugId;
      if (bugId === undefined || bugId === null || bugId === '') return;
      try {
        const access = await canJoinBugRoom(bugId, Number(userId));
        if (!access.allowed) {
          socket.emit('error', { message: BUG_ROOM_DENIED });
          return;
        }
        socket.join(`bug_${bugId}`);
        socket.to(`bug_${bugId}`).emit('user_online', { userId });
      } catch (error) {
        console.error('Error joining bug room:', error);
        socket.emit('error', { message: BUG_ROOM_DENIED });
      }
    });

    // Leave bug discussion room
    socket.on('leave_bug_room', (data: { bugId: string }) => {
      if (!data.bugId) return;
      if (!socket.rooms.has(`bug_${data.bugId}`)) return;
      socket.leave(`bug_${data.bugId}`);
      socket.to(`bug_${data.bugId}`).emit('user_offline', { userId });
    });

    // Typing indicator for bugs
    socket.on('bug_typing', (data: { bugId: string, userName: string }) => {
      if (!data.bugId) return;
      if (!socket.rooms.has(`bug_${data.bugId}`)) return;
      socket.to(`bug_${data.bugId}`).emit('typing', {
        userId,
        userName: data.userName
      });
    });

    // Stop typing indicator for bugs
    socket.on('stop_bug_typing', (data: { bugId: string }) => {
      if (!data.bugId) return;
      if (!socket.rooms.has(`bug_${data.bugId}`)) return;
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

    // --- MY TASKS DISCUSSION ROOMS (standalone module) ---
    // STRICT membership (creator / member / admin), mirroring the REST chat guard
    // so socket access can never diverge. Uses its OWN room (mytask_<id>) and its
    // OWN membership source (my_task_members) — never touches the Development task
    // rooms/tables.
    socket.on('join_mytask_room', async (data: { taskId: number }) => {
      if (!data.taskId) return;
      try {
        const access = await canAccessMyTask(Number(data.taskId), Number(userId));
        if (!access.task) {
          socket.emit('error', { message: 'Task not found' });
          return;
        }
        if (!access.allowed) {
          socket.emit('error', { message: 'Unauthorized: you are not a member of this task' });
          return; // Reject join.
        }
        socket.join(`mytask_${data.taskId}`);
        socket.to(`mytask_${data.taskId}`).emit('user_online', { userId });
      } catch (error) {
        console.error('Error joining my-task room:', error);
      }
    });

    socket.on('leave_mytask_room', (data: { taskId: number }) => {
      if (!data.taskId) return;
      socket.leave(`mytask_${data.taskId}`);
      socket.to(`mytask_${data.taskId}`).emit('user_offline', { userId });
    });

    socket.on('mytask_typing', (data: { taskId: number, userName: string }) => {
      if (!data.taskId) return;
      socket.to(`mytask_${data.taskId}`).emit('mytask_typing', { userId, userName: data.userName });
    });

    socket.on('mytask_stop_typing', (data: { taskId: number }) => {
      if (!data.taskId) return;
      socket.to(`mytask_${data.taskId}`).emit('mytask_stop_typing', { userId });
    });

    socket.on('disconnect', () => {
      // console.log(`User disconnected from socket: ${userId}`);
    });
  });

  return io;
};
