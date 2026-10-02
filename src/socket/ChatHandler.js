import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/AppError.js';
import { chatSchema, reactionSchema } from '../rooms/chatMessages.js';
import { ACTIONS, RolePolicy } from '../rooms/RolePolicy.js';
import { withAck } from './ack.js';
import { getRoomContext } from './context.js';

/**
 * Chat and emoji reactions for ONE connected socket: send_message, send_reaction.
 * Same steps as every other handler: who are you -> may you -> is the input valid -> do it.
 * Messages and reactions go to everyone in the room, including the sender.
 */
export class ChatHandler {
  constructor({ socket, roomManager, limiter, chatLimiter, reactionLimiter }) {
    this.socket = socket;
    this.roomManager = roomManager;
    this.limiter = limiter;
    this.chatLimiter = chatLimiter;
    this.reactionLimiter = reactionLimiter;
  }

  register() {
    this.socket.on(
      'send_message',
      withAck((payload) => this.#sendMessage(payload), {
        limiter: [this.limiter, this.chatLimiter],
      }),
    );
    this.socket.on(
      'send_reaction',
      withAck((payload) => this.#sendReaction(payload), {
        limiter: [this.limiter, this.reactionLimiter],
      }),
    );
  }

  #context(action, deniedMessage) {
    const context = getRoomContext(this.socket, this.roomManager);
    if (!RolePolicy.can(context.participant.role, action)) {
      throw new AppError(403, deniedMessage, undefined, 'FORBIDDEN');
    }
    return context;
  }

  #sendMessage(payload) {
    const { room, participant } = this.#context(ACTIONS.SEND_CHAT, 'You are not allowed to chat');
    const { text } = chatSchema.parse(payload);

    const message = room.chat.add({
      id: randomUUID(),
      userId: participant.userId,
      username: participant.username,
      role: participant.role, // shown as a badge; it is the role at the moment of sending
      text,
      sentAt: new Date().toISOString(),
    });
    room.broadcast('chat_message', message);
    return { message };
  }

  #sendReaction(payload) {
    const { room, participant } = this.#context(
      ACTIONS.SEND_REACTION,
      'You are not allowed to send reactions',
    );
    const { emoji } = reactionSchema.parse(payload);

    const reaction = {
      id: randomUUID(),
      userId: participant.userId,
      username: participant.username,
      emoji,
      // Where the video was when they reacted, so clients can mark the moment.
      currentTime: room.playback.snapshot().currentTime,
      sentAt: new Date().toISOString(),
    };
    room.broadcast('reaction', reaction);
    return { reaction };
  }
}
