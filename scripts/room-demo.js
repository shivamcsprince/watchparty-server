// Manual test client. Keeps running and prints every room event until you press Ctrl+C.
//
//   node scripts/room-demo.js create <email> <password>
//   node scripts/room-demo.js join <ROOMCODE> <email> <password>
//
// Server URL defaults to http://localhost:4000 (override with SERVER_URL).
import { io } from 'socket.io-client';

const baseUrl = process.env.SERVER_URL ?? 'http://localhost:4000';
const [mode, ...args] = process.argv.slice(2);

function usage() {
  console.error('Usage:');
  console.error('  node scripts/room-demo.js create <email> <password>');
  console.error('  node scripts/room-demo.js join <ROOMCODE> <email> <password>');
  process.exit(1);
}

async function request(method, path, { token, body } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error}`);
  return data;
}

if (mode !== 'create' && mode !== 'join') usage();
const [code, email, password] = mode === 'join' ? args : [undefined, ...args];
if (!email || !password || (mode === 'join' && !code)) usage();

const { token, user } = await request('POST', '/api/auth/login', { body: { email, password } });
console.log(`Logged in as ${user.username}`);

let roomCode = code;
if (mode === 'create') {
  const { room } = await request('POST', '/api/rooms', { token });
  roomCode = room.code;
  console.log(`Created room. Share this code: ${roomCode}`);
}

const socket = io(baseUrl, { auth: { token }, transports: ['websocket'] });
const show = (label, data) => console.log(`[${label}]`, JSON.stringify(data));

socket.on('connect_error', (err) => console.error('Connection failed:', err.message));
for (const event of ['user_joined', 'user_left', 'session_replaced']) {
  socket.on(event, (payload) => show(event, payload));
}
socket.on('disconnect', (reason) => console.log(`Disconnected (${reason})`));

socket.on('connect', () => {
  socket.emit('join_room', { roomId: roomCode }, (response) => {
    show('join_room reply', response);
    if (!response.ok) process.exit(1);
    console.log('Waiting for events... (Ctrl+C to leave)');
  });
});
