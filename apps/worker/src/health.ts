import { createServer, type Server } from 'node:http';

/** Tiny HTTP health endpoint for container healthchecks. */
export function startHealthServer(port: number, getStatus: () => object): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ...getStatus() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port);
  return server;
}
