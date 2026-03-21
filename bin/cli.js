#!/usr/bin/env node
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const server = await createServer({
  root,
  server: { open: true },
});

await server.listen();
server.printUrls();
