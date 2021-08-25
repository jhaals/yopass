import { Route, Switch } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';
import ClickThroughToSecret from './displaySecret/ClickThroughToSecret';

export const Routes = () => {
  return (
    <Switch>
      <Route path="/" exact={true} component={CreateSecret} />
      <Route path="/upload" exact={true} component={Upload} />
      <Route
        exact={true}
        path="/:format(s|f)/:key/:password?"
        component={DisplaySecret}
      />
      <Route
        exact={true}
        path="/c/:format(s|f)/:key/:password?"
        component={ClickThroughToSecret}
      />
    </Switch>
  );
};
