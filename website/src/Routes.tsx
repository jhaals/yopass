import { Route } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';
import Blank from './blank/Blank';
import Callback from './callback/Callback';

export const Routes = () => {
  return (
    <div>
      <Route exact path="/" component={Blank} />
      <Route path="/blank" component={Blank} />
      <Route path="/callback" component={Callback} />
      <Route path="/create" exact={true} component={CreateSecret} />
      <Route path="/upload" exact={true} component={Upload} />
      <Route exact={true} path="/s/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/s/:key" component={DisplaySecret} />
      <Route exact={true} path="/f/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/f/:key" component={DisplaySecret} />
    </div>
  );
};
