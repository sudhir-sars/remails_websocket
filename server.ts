import * as dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const HOST = process.env.WEB_SOCKET_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!;

interface User {
  userId: string;
  username: string;
  email: string;
  status: 'online' | 'offline';
  socketIds: string[];
}

interface Users {
  [userId: string]: User;
}

const users: Users = {};
const adminSockets: Set<string> = new Set();

// Function to generate dummy users
function generateDummyUsers(count: number): Users {
  const dummyUsers: Users = {};
  for (let i = 1; i <= count; i++) {
    const userId = `user${i}`;
    dummyUsers[userId] = {
      userId,
      username: `User ${i}`,
      email: `user${i}@example.com`,
      status: Math.random() > 0.5 ? 'online' : 'offline',
      socketIds: [],
    };
  }
  return dummyUsers;
}

// // Generate 20 dummy users
// const dummyUsers = generateDummyUsers(20);
// Object.assign(users, dummyUsers);

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('registerUser', (userData: { userId: string; username: string; email: string }) => {
      const { userId, username, email } = userData;
      if (!users[userId]) {
        users[userId] = { userId, username, email, status: 'online', socketIds: [] };
      }
      users[userId].socketIds.push(socket.id);
      users[userId].status = 'online';
      console.log(`User ${userId} registered with socket id ${socket.id}`);
      emitConnectedUsers();
    });

    socket.on('disconnect', () => {
      for (const userId in users) {
        const index = users[userId].socketIds.indexOf(socket.id);
        if (index !== -1) {
          users[userId].socketIds.splice(index, 1);
          console.log(`User ${userId} with socket id ${socket.id} disconnected`);
          if (users[userId].socketIds.length === 0) {
            users[userId].status = 'offline';
          }
          emitConnectedUsers();
          break;
        }
      }
      adminSockets.delete(socket.id);
    });

    socket.on('adminConnect', async (token: string) => {
      try {
        const response = await fetch(`${HOST}/api/auth/admin/verifyExistingUser`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
          console.log('Admin connected:', data.user);
          adminSockets.add(socket.id);
          socket.join('admin');
          emitConnectedUsers();
        } else {
          console.log('Invalid token or credentials');
          socket.disconnect();
        }
      } catch (error) {
        console.log('Token verification failed', error);
        socket.disconnect();
      }
    });

    socket.on('broadcastToAll', (message: string) => {
      if (adminSockets.has(socket.id)) {
        console.log('Admin broadcasting message to all users:', message);
        io.emit('broadcastMessage', message);
      } else {
        console.log('Unauthorized message send attempt');
      }
    });

    socket.on('broadcastToUser', (data: { userId: string; message: string }) => {
      if (adminSockets.has(socket.id)) {
        const { userId, message } = data;
        const user = users[userId];
        if (user && user.socketIds.length > 0) {
          console.log(`Admin broadcasting message to user ${userId}:`, message);
          user.socketIds.forEach((socketId) => {
            io.to(socketId).emit('broadcastMessage', message);
          });
        } else {
          console.log(`No sockets found for user ${userId}`);
        }
      } else {
        console.log('Unauthorized message send attempt');
      }
    });

    socket.on('disconnectUser', (userId: string) => {
      if (adminSockets.has(socket.id)) {
        const user = users[userId];
        if (user) {
          user.socketIds.forEach((socketId) => {
            io.sockets.sockets.get(socketId)?.disconnect(true);
          });
          users[userId].status = 'offline';
          users[userId].socketIds = [];
          emitConnectedUsers();
          console.log(`Admin disconnected user ${userId}`);
        } else {
          console.log(`User ${userId} not found`);
        }
      } else {
        console.log('Unauthorized disconnect attempt');
      }
    });
  });

  function emitConnectedUsers() {
    const connectedUsers = Object.values(users).map(({ userId, username, email, status }) => ({
      id: userId,
      username,
      email,
      status,
    }));
    io.to('admin').emit('connectedUsers', connectedUsers);
  }

  // Emit initial dummy users to admins
  emitConnectedUsers();

  (global as any).io = io;
  (global as any).users = users;

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`> WebSocket server ready on http://localhost:${PORT}`);
  });
});
