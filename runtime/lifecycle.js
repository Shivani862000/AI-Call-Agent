function createHealthHandler({ ping, clock = () => new Date() }) {
  if (typeof ping !== 'function') throw new TypeError('Health handler requires ping');
  return async (_req, res) => {
    const timestamp = clock().toISOString();
    try {
      await ping();
      res.status(200).json({ ok: true, database: 'connected', timestamp });
    } catch {
      res.status(503).json({ ok: false, database: 'unavailable', timestamp });
    }
  };
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function shutdownRuntime({ stopScheduler, server, postgres, logger }) {
  logger?.info('runtime_shutdown_started');
  try {
    await stopScheduler?.();
    await closeServer(server);
    await postgres?.close();
    logger?.info('runtime_shutdown_completed');
  } catch (error) {
    logger?.error('runtime_shutdown_failed', { error });
    throw error;
  }
}

module.exports = { createHealthHandler, shutdownRuntime };
