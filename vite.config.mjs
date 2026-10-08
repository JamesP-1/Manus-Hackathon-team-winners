import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The DCU timetable feed (timetable.redbrick.dcu.ie) sends no
 * Access-Control-Allow-Origin header, so the browser cannot fetch it directly.
 * The app requests `/api/timetable/...` on its own origin and the dev/preview
 * server forwards that to `https://timetable.redbrick.dcu.ie/api/v3/timetable/...`.
 * A static deployment needs the same rewrite on its host (see README).
 */
const timetableProxy = {
  '/api/timetable': {
    target: 'https://timetable.redbrick.dcu.ie',
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(/^\/api\/timetable/, '/api/v3/timetable'),
  },
};

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
    server: { proxy: timetableProxy },
    preview: { proxy: timetableProxy },
    build: { outDir: 'dist', sourcemap: false },
  };
});
