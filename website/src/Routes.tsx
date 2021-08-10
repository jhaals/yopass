import { Route } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';
import Blank from './blank/Blank';
import LoginCallback from './authentication/LoginCallback';

export const Routes = () => {
  return (
    <div>
      <Route path="/" exact={true} component={Blank} />
      <Route path="/callback" exact={true} component={LoginCallback} />
      <Route path="/blank" exact={true} component={Blank} />
      {/* TODO: redirects to the blank/login screen if you're not yet authenticated. */}
      {/* https://reactrouter.com/web/example/auth-workflow */}
      <Route path="/create" exact={true} component={CreateSecret} />
      <Route path="/upload" exact={true} component={Upload} />
      <Route exact={true} path="/s/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/s/:key" component={DisplaySecret} />
      <Route exact={true} path="/f/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/f/:key" component={DisplaySecret} />
    </div>
  );
};
