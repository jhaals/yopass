import { Route } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';
import Blank from './blank/Blank';
import { AuthProvider } from 'oidc-react';
import { OidcConfiguration } from './OidcConfiguration';

export const Routes = () => {
  return (
    <div>
      <Route exact path="/" component={Blank} />
      <Route path="/blank" component={Blank} />
      <AuthProvider {...OidcConfiguration}>
        <Route path="/callback" component={Blank} />
        {/* <Route path="/createSecret" exact={true} component={CreateSecret} /> */}
        <Route path="/create" exact={true} component={CreateSecret} />
        <Route path="/upload" exact={true} component={Upload} />
      </AuthProvider>
      <Route exact={true} path="/s/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/s/:key" component={DisplaySecret} />
      <Route exact={true} path="/f/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/f/:key" component={DisplaySecret} />
    </div>
  );
};
