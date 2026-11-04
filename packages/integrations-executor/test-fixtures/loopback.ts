/**
 * Loopback-only test servers. Nothing in this suite leaves 127.0.0.1.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface Loopback {
  readonly server: Server;
  readonly port: number;
  readonly base: string;
}

export const listen = (handler: RequestHandler): Promise<Loopback> =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });

export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
  });

export const writeJson = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};
