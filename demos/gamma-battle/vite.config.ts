import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({ root,
  server: { host: '127.0.0.1', port: 5175, strictPort: true, proxy: { '/api/gamma': 'http://127.0.0.1:8791' } },
  build: { outDir: '.runtime/gamma-web', emptyOutDir: true, rollupOptions: { input: {
    battle: fileURLToPath(new URL('./index.html', import.meta.url)),
    world: fileURLToPath(new URL('../gamma-world/index.html', import.meta.url))
  } } }
});
