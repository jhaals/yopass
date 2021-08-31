import { Route } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';
import Blank from './blank/Blank';
import SignInCallback from './callback/SignInCallback';
import SignOutCallback from './callback/SignOutCallback';

export const Routes = () => {
  return (
    <div>
      <Route exact path="/" component={Blank} />
      <Route path="/blank" component={Blank} />
      <Route path="/signincallback" component={SignInCallback} />
      <Route path="/signoutcallback" component={SignOutCallback} />
      <Route path="/create" exact={true} component={CreateSecret} />
      <Route path="/upload" exact={true} component={Upload} />
      <Route
        exact={true}
        path="/:format(s|f)/:key/:password?"
        component={DisplaySecret}
      />
    </div>
  );
};
