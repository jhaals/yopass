import { Route } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';

export const Routes = () => {
  return (
    <div>
      <Route path="/" exact={true} component={CreateSecret} />
      <Route path="/upload" exact={true} component={Upload} />
      <Route exact={true} path="/(s|f)/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/(s|f)/:key" component={DisplaySecret} />
    </div>
  );
};
