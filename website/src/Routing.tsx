import { Route, Routes } from 'react-router-dom';

import CreateSecret from './createSecret/CreateSecret';
import DisplaySecret from './displaySecret/DisplaySecret';
import Upload from './createSecret/Upload';
import { useConfig } from './shared/ConfigContext';

export const Routing = () => {
  const oneClickLink = process.env.YOPASS_DISABLE_ONE_CLICK_LINK !== '1';
  const { DISABLE_UPLOAD } = useConfig();
  return (
    <Routes>
      <Route path="/" element={<CreateSecret />} />
      {!DISABLE_UPLOAD && <Route path="/upload" element={<Upload />} />}
      {oneClickLink && (
        <Route path="/:format/:key/:password" element={<DisplaySecret />} />
      )}
      <Route path="/:format/:key" element={<DisplaySecret />} />
    </Routes>
  );
};
