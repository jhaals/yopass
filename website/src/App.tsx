import { FC } from 'react';
import { BrowserRouter as Router, Route, Switch } from 'react-router-dom';
import { Container } from '@material-ui/core';
import { ThemeProvider } from '@material-ui/core/styles';

import { theme } from './theme';
import { AuthProvider } from 'oidc-react';
import Blank from './blank/Blank';
import CreateSecret from './createSecret/CreateSecret';
import Upload from './createSecret/Upload';
import DisplaySecret from './displaySecret/DisplaySecret';
import { Header } from './shared/Header';
import { oidcConfig } from './oidc-config';

if (process.env.NODE_ENV !== 'production') {
  console.log('App!');
  // console.log(process.env.REACT_APP_ELVID_AUTHORITY)
  // console.log(process.env.REACT_APP_ELVID_CLIENT_ID)
}

const Dashboard: FC = () => {
  return <h1>This is the dashboard</h1>;
};

const App: FC = () => {
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
      <Container maxWidth={'lg'}>
        <Router>
          <Header />
          <Switch>
            <Route exact path="/" component={Dashboard} />
            <Route path="/blank" component={Blank} />
            <Route path="/s/:key/:password" component={DisplaySecret} />
            <Route path="/s/:key" component={DisplaySecret} />
            <Route path="/f/:key/:password" component={DisplaySecret} />
            <Route path="/f/:key" component={DisplaySecret} />

            <AuthProvider {...oidcConfig}>
              <Route path="/callback" component={Dashboard} />
              <Route path="/create" component={CreateSecret} />
              <Route path="/upload" component={Upload} />
            </AuthProvider>
          </Switch>
        </Router>
      </Container>
    </ThemeProvider>
  );
};

export default App;
