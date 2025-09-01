import { Container, CssBaseline } from '@mui/material';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';

import { Header } from './shared/Header';
import { Routing } from './Routing';
import { Features } from './shared/Features';
import { Attribution } from './shared/Attribution';
import { theme } from './theme';
import { HashRouter } from 'react-router-dom';
import { ConfigProvider } from './shared/ConfigContext';

const App = () => {
  // TODO: Removed in future version.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister();
      }
    });
  }

  const features = process.env.YOPASS_DISABLE_FEATURES_CARDS !== '1';
  return (
    <StyledEngineProvider injectFirst>
      <ThemeProvider theme={theme} defaultMode="system">
        <CssBaseline />
        <HashRouter>
          <ConfigProvider>
            <Header />
            <Container maxWidth={'lg'}>
              <Routing />
              {features && <Features />}
              <Attribution />
            </Container>
          </ConfigProvider>
        </HashRouter>
      </ThemeProvider>
    </StyledEngineProvider>
  );
};

export default App;
