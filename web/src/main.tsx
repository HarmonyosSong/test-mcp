import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@arco-design/web-react/dist/css/arco.css';
import App from './App';
import { SessionGate } from './auth';
import './styles.css';
import './retro.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionGate>
      <App />
    </SessionGate>
  </StrictMode>,
);
