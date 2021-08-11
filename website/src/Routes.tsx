import { Route } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';
import Blank from './blank/Blank';
// import LoginCallback from './authentication/LoginCallback';
import { AuthProvider, AuthProviderProps } from 'oidc-react';

const oidcConfig: AuthProviderProps = {
  onSignIn: async (user: any) => {
    alert('Signed in.');
    console.log(user);
    window.location.hash = '';
  },
  autoSignIn: false,
  automaticSilentRenew: false,
  authority: process.env.REACT_APP_ELVID_AUTHORITY,
  clientId: process.env.REACT_APP_ELVID_CLIENT_ID,
  responseType: 'code',
  redirectUri:
    process.env.NODE_ENV === 'development'
      ? 'http://localhost:3000/'
      : 'https://onetime.test-elvia.io',
};

export const Routes = () => {
  return (
    <div>
      {/* <Route path="/" exact={true} component={CreateSecret} />
      <Route path="/upload" exact={true} component={Upload} /> */}
      <Route path="/" exact={true} component={Blank} />
      {/* <Route path="/callback" exact={true} component={LoginCallback} /> */}
      <Route path="/blank" exact={true} component={Blank} />
      {/* TODO: redirects to the blank/login screen if you're not yet authenticated. */}
      {/* https://reactrouter.com/web/example/auth-workflow */}
      <Route exact={true} path="/s/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/s/:key" component={DisplaySecret} />
      <Route exact={true} path="/f/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/f/:key" component={DisplaySecret} />

      <AuthProvider {...oidcConfig}>
        <Route path="/create" exact={true} component={CreateSecret} />
        <Route path="/upload" exact={true} component={Upload} />
      </AuthProvider>
    </div>
  );
};
