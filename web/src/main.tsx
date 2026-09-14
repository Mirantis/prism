import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installPluginHost } from './plugin-host';
import '@k8slens/lds/style.css';
import './styles/globals.css';

// Before the router renders, so a plugin page imported later finds the host
// it was built against.
installPluginHost();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No #root element');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
