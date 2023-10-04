import { Container } from '@mui/material';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';

import { Footer } from './shared/Footer';
import { Header } from './shared/Header';
import { Routing } from './Routing';
import { theme } from './theme';
import { HashRouter } from 'react-router-dom';

const App = () => {
  // TODO: Removed in future version.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister();
      }
    });
  }

  return (
    <StyledEngineProvider injectFirst>
      <ThemeProvider theme={theme}>
        <HashRouter>
          <Header />
          <Container maxWidth={'lg'}>
            <Routing />
          </Container>
          <Footer />
        </HashRouter>
      </ThemeProvider>
    </StyledEngineProvider>
  );
};

export default App;
