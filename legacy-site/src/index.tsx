import { createRoot } from 'react-dom/client';
import { Suspense } from 'react';
import App from './App';
import './i18n';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(
  <Suspense fallback={<div className="placeholder">Loading...</div>}>
    <App />
  </Suspense>,
);
