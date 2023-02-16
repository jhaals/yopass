import { Route, Routes } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';

export const Routing = () => {
  return (
    <Routes>
      <Route path="/" element={<CreateSecret />} />
      <Route path="/:format/:key/:password" element={<DisplaySecret />} />
      <Route path="/:format/:key" element={<DisplaySecret />} />
    </Routes>
  );
};
