import { saveAs } from 'file-saver';
import * as React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import Error from './Error';
import Form from '../createSecret/Form';
import { backendDomain, decryptMessage } from '../utils/utils';
import { useTranslation } from 'react-i18next';
import Loading from '../shared/Loading';

const Download: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [error, showError] = useState(false);
  const { key, password } = useParams<DisplayParams>();
  const location = useLocation();
  const isEncoded = null !== location.pathname.match(/\/d\//);

  const decrypt = useCallback(async () => {
    if (!password) {
      return;
    }
    setLoading(true);
    try {
      const request = await fetch(`${backendDomain}/file/${key}`);
      if (request.status === 200) {
        const data = await request.json();
        console.log(isEncoded);
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
        setLoading(false);
        return;
      }
    } catch (e) {
      console.log(e);
    }
    setLoading(false);
    showError(true);
  }, [password, key, isEncoded]);

  useEffect(() => {
    decrypt();
  }, [decrypt]);

  return (
    <div>
      {loading && <Loading />}
      {!loading && password && !error && <DownloadSuccess />}
      <Error display={error} />
      <Form display={!password} uuid={key} prefix={isEncoded ? 'd' : 'f'} />
    </div>
  );
};

const DownloadSuccess: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div>
      <h3>{t('Downloading file and decrypting in browser, please hold...')}</h3>
      <p>
        {t('Make sure to download the file since it is only available once')}
      </p>
    </div>
  );
};
export default Download;
