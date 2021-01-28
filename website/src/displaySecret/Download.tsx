import { saveAs } from 'file-saver';
import { useParams, useLocation } from 'react-router-dom';
import Error from './Error';
import Form from '../createSecret/Form';
import { backendDomain, decryptMessage } from '../utils/utils';
import { useTranslation } from 'react-i18next';
import Loading from '../shared/Loading';
import { useAsync } from 'react-use';
import { DisplayParams } from './DisplaySecret';
import { Typography } from '@material-ui/core';

const Download = () => {
  const { key, password } = useParams<DisplayParams>();
  const location = useLocation();
  const isEncoded = null !== location.pathname.match(/\/d\//);

  const state = useAsync(async () => {
    if (!password) {
      return;
    }
    const request = await fetch(`${backendDomain}/file/${key}`);
    const data = await request.json();
    const file = await decryptMessage(
      data.message,
      isEncoded ? atob(password) : password,
      'binary',
    );
    saveAs(
      new Blob([file.data as string], {
        type: 'application/octet-stream',
      }),
      file.filename,
    );
    return true;
  }, [password, key, isEncoded]);

  return (
    <div>
      {state.loading && <Loading />}
      {state.value && <DownloadSuccess />}
      <Error error={state.error} />
      <Form display={!password} uuid={key} prefix={isEncoded ? 'd' : 'f'} />
    </div>
  );
};

const DownloadSuccess = () => {
  const { t } = useTranslation();
  return (
    <div>
      <Typography variant="h4">
        {t('Downloading file and decrypting in browser, please hold...')}
      </Typography>
      <Typography>
        {t('Make sure to download the file since it is only available once')}
      </Typography>
    </div>
  );
};
export default Download;
