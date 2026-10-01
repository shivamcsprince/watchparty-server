// Manual test client. Joins a room, prints every event, and lets you type commands.
//
//   node scripts/room-demo.js create <email> <password>
//   node scripts/room-demo.js join <ROOMCODE> <email> <password>
//
// Commands once connected:
//   video <youtube-link-or-id>   play   pause   seek <seconds>   sync   quit
//
// Server URL defaults to http://localhost:4000 (override with SERVER_URL).
import readline from 'node:readline';
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
for (const event of ['user_joined', 'user_left', 'sync_state', 'session_replaced']) {
  socket.on(event, (payload) => show(event, payload));
}
socket.on('disconnect', (reason) => console.log(`Disconnected (${reason})`));

function send(event, payload) {
  socket.emit(event, payload, (reply) => show(`${event} reply`, reply));
}

function handleCommand(line) {
  const [command, ...rest] = line.trim().split(/\s+/);
  switch (command) {
    case 'video':
      return send('change_video', { videoId: rest.join(' ') });
    case 'play':
      return send('play');
    case 'pause':
      return send('pause');
    case 'seek':
      return send('seek', { time: Number(rest[0]) });
    case 'sync':
      return send('request_sync');
    case 'quit':
      return process.exit(0);
    case '':
      return undefined;
    default:
      return console.log('Commands: video <link|id>, play, pause, seek <seconds>, sync, quit');
  }
}

socket.on('connect', () => {
  socket.emit('join_room', { roomId: roomCode }, (response) => {
    show('join_room reply', response);
    if (!response.ok) process.exit(1);
    console.log(
      'Connected. Type a command (video, play, pause, seek, sync, quit) or Ctrl+C to leave.',
    );
    readline.createInterface({ input: process.stdin }).on('line', handleCommand);
  });
});
