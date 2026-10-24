import { createServer } from 'vite';
import { createApp } from '../server/app.mjs';
const app = createApp();
const api = app.listen(5279, '127.0.0.1');
const vite = await createServer();
await vite.listen();
console.log('ZecPaid: http://127.0.0.1:5278');
async function stop() { await vite.close(); api.close(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
