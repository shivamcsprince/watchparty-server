// Manual test client. Joins a room, prints every event, and lets you type commands.
//
//   node scripts/room-demo.js create <email> <password>
//   node scripts/room-demo.js join <ROOMCODE> <email> <password>
//
// Commands once connected (host/moderator control playback directly; participants use "request"):
//   video <youtube-link-or-id>   play   pause   seek <seconds>   sync
//   who                                   list people and their roles
//   role <username> <moderator|participant|viewer>      (host only)
//   remove <username>                                   (host only; they can rejoin)
//   request play|pause|seek <seconds>|video <link>      (participants: ask for approval)
//   requests                              list pending requests
//   approve <id-start> / reject <id-start>              (host or moderator)
//   say <message>                        chat (not viewers)
//   react <emoji>                         one of: 👍 ❤️ 😂 😮 😢 👏 🔥 🎉 (not viewers)
//   leave                                 leave the room on purpose (then press Ctrl+C)
//   quit                                  disconnect (as if the connection dropped)
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

async function main() {
  let token;
  let roomCode = code;
  try {
    const login = await request('POST', '/api/auth/login', { body: { email, password } });
    token = login.token;
    console.log(`Logged in as ${login.user.username}`);

    if (mode === 'create') {
      const { room } = await request('POST', '/api/rooms', { token });
      roomCode = room.code;
      console.log(`Created room. Share this code: ${roomCode}`);
    }
  } catch (err) {
    // Print a helpful message and let the process end on its own. Calling process.exit() or crashing
    // while a connection is closing triggers a Node 24 assertion on Windows.
    console.error(`\nCould not start: ${err.message}`);
    if (String(err.message).includes('401')) {
      console.error(
        'Hint: that email/password is not registered. Register the user first (see the README).',
      );
    } else if (String(err.cause?.code ?? err.message).match(/ECONNREFUSED|fetch failed/)) {
      console.error(`Hint: is the server running at ${baseUrl}? Start it with: npm run dev`);
    }
    process.exitCode = 1;
    return;
  }

  const socket = io(baseUrl, { auth: { token }, transports: ['websocket'] });
  const show = (label, data) => console.log(`[${label}]`, JSON.stringify(data));

  let readlineInterface;

  // What this client knows about the room, kept up to date from server events.
  let participants = [];
  const pending = new Map(); // request id -> request

  const updateParticipants = (payload) => {
    if (payload?.participants) participants = payload.participants;
  };
  const findPerson = (name) => participants.find((p) => p.username === name);
  const findRequest = (prefix) => [...pending.values()].find((r) => r.id.startsWith(prefix));

  socket.on('connect_error', (err) => console.error('Connection failed:', err.message));
  for (const event of [
    'user_joined',
    'user_left',
    'role_assigned',
    'participant_removed',
    'sync_state',
    'session_replaced',
    'chat_message',
    'reaction',
  ]) {
    socket.on(event, (payload) => {
      updateParticipants(payload);
      show(event, payload);
    });
  }
  socket.on('request_created', (payload) => {
    pending.set(payload.request.id, payload.request);
    show('request_created', payload);
    console.log(
      `  -> answer with: approve ${payload.request.id.slice(0, 6)}  /  reject ${payload.request.id.slice(0, 6)}`,
    );
  });
  socket.on('request_resolved', (payload) => {
    pending.delete(payload.requestId);
    show('request_resolved', payload);
  });
  socket.on('disconnect', (reason) => console.log(`Disconnected (${reason})`));

  function send(event, payload) {
    socket.emit(event, payload, (reply) => {
      updateParticipants(reply);
      show(`${event} reply`, reply);
    });
  }

  function resolve(decision, prefix) {
    const request = findRequest(prefix ?? '');
    if (!request) return console.log('No pending request matches that id. Try: requests');
    return send('resolve_request', { requestId: request.id, decision });
  }

  function handleCommand(line) {
    const [command, ...rest] = line.trim().split(/\s+/);
    switch (command) {
      case 'video':
        return send('change_video', { videoId: rest.join(' ') });
      case 'play':
      case 'pause':
        return send(command);
      case 'seek':
        return send('seek', { time: Number(rest[0]) });
      case 'sync':
        return send('request_sync');
      case 'who':
        return console.log(participants.map((p) => `${p.username} (${p.role})`).join(', '));
      case 'role': {
        const person = findPerson(rest[0]);
        if (!person) return console.log(`Nobody called "${rest[0]}". Try: who`);
        return send('assign_role', { userId: person.userId, role: rest[1] });
      }
      case 'remove': {
        const person = findPerson(rest[0]);
        if (!person) return console.log(`Nobody called "${rest[0]}". Try: who`);
        return send('remove_participant', { userId: person.userId });
      }
      case 'request': {
        const [action, arg] = rest;
        if (action === 'seek') return send('request_action', { action: 'seek', time: Number(arg) });
        if (action === 'video') {
          return send('request_action', {
            action: 'change_video',
            videoId: rest.slice(1).join(' '),
          });
        }
        return send('request_action', { action });
      }
      case 'requests':
        return send('list_requests');
      case 'approve':
        return resolve('approve', rest[0]);
      case 'reject':
        return resolve('reject', rest[0]);
      case 'say':
        return send('send_message', { text: rest.join(' ') });
      case 'react':
        return send('send_reaction', { emoji: rest[0] });
      case 'leave':
        return send('leave_room', {});
      case 'quit':
        socket.close();
        return readlineInterface?.close();
      case '':
        return undefined;
      default:
        return console.log('Unknown command. See the list at the top of scripts/room-demo.js');
    }
  }

  socket.on('connect', () => {
    socket.emit('join_room', { roomId: roomCode }, (response) => {
      show('join_room reply', response);
      if (!response.ok) {
        process.exitCode = 1;
        socket.close();
        return;
      }
      updateParticipants(response);
      for (const request of response.requests ?? []) pending.set(request.id, request);
      console.log(
        `Connected as ${response.you.role} (${response.messages?.length ?? 0} earlier chat messages). Type a command (see top of scripts/room-demo.js) or Ctrl+C.`,
      );
      readlineInterface = readline.createInterface({ input: process.stdin });
      readlineInterface.on('line', handleCommand);
    });
  });
}

main();
