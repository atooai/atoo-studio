import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root')!;
const root = createRoot(container);
root.render(<App />);

if ('serviceWorker' in navigator) {
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (isLocalhost || location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
