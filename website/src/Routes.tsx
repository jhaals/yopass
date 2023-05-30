import { Route, Routes as ReactRoutes } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';
import Blank from './blank/Blank';
import SignInCallback from './callback/SignInCallback';
import SignOutCallback from './callback/SignOutCallback';

export const Routes = () => {
  return (
    <ReactRoutes>
      <Route path="/" element={<CreateSecret />} />
      <Route path="/blank" element={<Blank />} />
      <Route path="/signincallback" element={<SignInCallback />} />
      <Route path="/signoutcallback" element={<SignOutCallback />} />
      <Route path="/create" element={<CreateSecret />} />
      <Route path="/upload" element={<Upload />} />
      <Route path="/:format/:key/:password" element={<DisplaySecret />} />
      <Route path="/:format/:key" element={<DisplaySecret />} />
    </ReactRoutes>
  );
};
