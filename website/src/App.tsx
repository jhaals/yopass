import { HashRouter as Router } from 'react-router-dom';
import { Container } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';

import { Header } from './shared/Header';
import { Routes } from './Routes';
// import { Features } from './shared/Features';
// import { Attribution } from './shared/Attribution';
import { theme } from './theme';
import { AuthProvider } from 'oidc-react';
import { OidcConfiguration } from './oidc/OidcConfiguration';

if (process.env.NODE_ENV !== 'production') {
  console.log('App in non-production mode!');
} else {
  console.log('App in production mode!');
}

console.log(process.env.REACT_APP_ELVID_AUTHORITY);
console.log(process.env.REACT_APP_ELVID_CLIENT_ID);
console.log(process.env.REACT_APP_ELVID_REDIRECT_URI);
console.log(process.env.REACT_APP_ELVID_SCOPE);

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
    <ThemeProvider theme={theme}>
      <Router>
        <AuthProvider {...OidcConfiguration}>
          <Header />
          <Container maxWidth={'lg'}>
            <Routes />
            {/*
            <Features />
            <Attribution />
            */}
          </Container>
        </AuthProvider>
      </Router>
    </ThemeProvider>
  );
};

export default App;
