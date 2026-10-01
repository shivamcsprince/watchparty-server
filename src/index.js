import { config } from './config/env.js';
import { createServer } from './server.js';
import { pool } from './db/pool.js';

const { httpServer, socketServer } = createServer();

httpServer.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
  console.log(`[server] allowed client origins: ${config.clientOrigins.join(', ')}`);
  console.log(`[server] room capacity: ${config.roomCapacity}`);
});

// Graceful shutdown: Render sends SIGTERM on every redeploy.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down...`);

  const forceExit = setTimeout(() => {
    console.error('[server] Forced exit after timeout');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await socketServer.close();
    await pool.end();
    console.log('[server] Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[server] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});
