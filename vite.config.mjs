import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const publicValue = (name) => JSON.stringify(process.env[name] || env[name] || '');
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_MANUS_API_URL': publicValue('MANUS_API_URL'),
      'import.meta.env.VITE_MANUS_API_BROWSER_KEY': publicValue('MANUS_API_BROWSER_KEY'),
      'import.meta.env.VITE_GOOGLE_MAPS_API_KEY': publicValue('VITE_GOOGLE_MAPS_API_KEY'),
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});
