import { Route, Routes } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';

export const Routing = () => {
  return (
    <Routes>
      <Route path="/" element={<CreateSecret />} />
      <Route path="/upload" element={<Upload />} />
      <Route path="/:format/:key/:password" element={<DisplaySecret />} />
      <Route path="/:format/:key" element={<DisplaySecret />} />
    </Routes>
  );
};
