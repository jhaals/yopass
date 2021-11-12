import { Container } from '@mui/material';
import {
  ThemeProvider,
  Theme,
  StyledEngineProvider,
} from '@mui/material/styles';

import { Header } from './shared/Header';
import { Routing } from './Routing';
import { Features } from './shared/Features';
import { Attribution } from './shared/Attribution';
import { theme } from './theme';
import { HashRouter } from 'react-router-dom';

declare module '@mui/styles/defaultTheme' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface DefaultTheme extends Theme {}
}

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
            <Features />
            <Attribution />
          </Container>
        </HashRouter>
      </ThemeProvider>
    </StyledEngineProvider>
  );
};

export default App;
