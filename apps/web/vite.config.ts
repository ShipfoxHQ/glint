import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';
import {webReadiness} from './src/health.js';

function healthPlugin(apiUrl: string): Plugin {
  const middleware = (middlewares: {
    use: (
      path: string,
      handler: (_request: unknown, response: import('node:http').ServerResponse) => void,
    ) => void;
  }) => {
    middlewares.use('/live', (_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({status: 'live'}));
    });
    middlewares.use('/ready', async (_request, response) => {
      const readiness = await webReadiness(apiUrl);
      response.statusCode = readiness.status === 'ready' ? 200 : 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(readiness));
    });
  };

  return {
    name: 'glint-health',
    configureServer: (server) => middleware(server.middlewares),
    configurePreviewServer: (server) => middleware(server.middlewares),
  };
}

const port = Number(process.env.GLINT_WEB_PORT ?? 3000);
const apiUrl = process.env.GLINT_WEB_API_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [healthPlugin(apiUrl), tailwindcss(), react()],
  server: {port, strictPort: true},
  preview: {port, strictPort: true},
});
