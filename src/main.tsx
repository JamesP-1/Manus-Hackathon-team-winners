import React from 'react';
import ReactDOM from 'react-dom/client';

function SetupCheckpoint() {
  return <main style={{ fontFamily: 'Segoe UI, sans-serif', maxWidth: 640, margin: '12vh auto', padding: 24, color: '#17263b' }}>
    <p style={{ color: '#1663ef', fontWeight: 800, letterSpacing: '0.1em' }}>DCU / NAV</p>
    <h1>Your room code, made clear.</h1>
    <p>The project is initialized. Room collection, building-code resolution and the interactive Google 3D view are being implemented in parallel.</p>
    <p>This setup checkpoint is a working development shell, not the completed navigator. Read README.md and plan.md before editing shared modules.</p>
  </main>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><SetupCheckpoint /></React.StrictMode>,
);
