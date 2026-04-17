import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@shared/styles/index.css';
import '@shared/lib/i18n';
import App from '@app/App.tsx';
import { ConfigProvider } from '@shared/context/ConfigContext';
import { ThemeProvider } from '@shared/theme/ThemeProvider';
import { AuthProvider } from '@shared/context/AuthContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider>
      <ThemeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </ConfigProvider>
  </StrictMode>,
);
