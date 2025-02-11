import { Container } from '@mui/material';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';

import { Header } from './shared/Header';
import { Routing } from './Routing';
import { Features } from './shared/Features';
import { Attribution } from './shared/Attribution';
import { theme } from './theme';
import { HashRouter } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

const Router = ({ children }: React.PropsWithChildren) => {
  if (process.env.ROUTER_TYPE === 'history') {
    return (
      <BrowserRouter>
        {children}
      </BrowserRouter>
    )
  }

  return (
    <HashRouter>
      {children}
    </HashRouter>
  )
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
        <Router>
          <Header />
          <Container maxWidth={'lg'}>
            <Routing />
            <Features />
            <Attribution />
          </Container>
        </Router>
      </ThemeProvider>
    </StyledEngineProvider>
  );
};

export default App;
