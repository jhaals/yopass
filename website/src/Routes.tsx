import * as React from 'react';
import { Route } from 'react-router-dom';

import Create from './createSecret/Create';
import DisplaySecret from './displaySecret/DisplaySecret';
import Download from './displaySecret/Download';
import Upload from './createSecret/Upload';

export const Routes: React.FC = () => {
  return (
    <div>
      <Route path="/" exact={true} component={Create} />
      <Route path="/upload" exact={true} component={Upload} />
      <Route exact={true} path="/s/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/c/:key/:password" component={DisplaySecret} />
      <Route exact={true} path="/s/:key" component={DisplaySecret} />
      <Route exact={true} path="/c/:key" component={DisplaySecret} />
      <Route exact={true} path="/f/:key/:password" component={Download} />
      <Route exact={true} path="/f/:key" component={Download} />
      <Route exact={true} path="/d/:key" component={Download} />
      <Route exact={true} path="/d/:key/:password" component={Download} />
    </div>
  );
};
