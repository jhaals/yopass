import { HashRouter as Router } from 'react-router-dom';
import { Container } from '@material-ui/core';
import { ThemeProvider } from '@material-ui/core/styles';

import { Header } from './shared/Header';
import { Routes } from './Routes';
// import { Features } from './shared/Features';
// import { Attribution } from './shared/Attribution';
import { theme } from './theme';

if (process.env.NODE_ENV !== 'production') {
  console.log('App in non-production mode!');
} else {
  console.log('App in production mode!');
}

console.log(process.env.REACT_APP_ELVID_AUTHORITY)
console.log(process.env.REACT_APP_ELVID_CLIENT_ID)
console.log(process.env.REACT_APP_ELVID_REDIRECT_URI)
console.log(process.env.REACT_APP_ELVID_SCOPE)

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
        <Header />
        <Container maxWidth={'lg'}>
          <Routes />
          {/* <Features />
          <Attribution /> */}
        </Container>
      </Router>
    </ThemeProvider>
  );
};

export default App;
