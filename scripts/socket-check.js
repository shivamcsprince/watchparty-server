// Usage: npm run check:socket   (server must be running)
import { io } from 'socket.io-client';

const url = process.env.SERVER_URL ?? 'http://localhost:4000';
const socket = io(url, { transports: ['websocket'], timeout: 10_000 });

socket.on('connect', () => {
  console.log(`Connected to ${url} with id ${socket.id}`);
  socket.emit('ping_check', (reply) => {
    console.log(`Server replied: ${reply}`);
    socket.close();
    process.exit(reply === 'pong' ? 0 : 1);
  });
});

socket.on('connect_error', (err) => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
