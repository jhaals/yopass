import * as React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import Error from './Error';
import Form from './Form';
import { decryptMessage } from './utils';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Button } from 'reactstrap';
import Clipboard from 'clipboard';

const DisplaySecret = () => {
  const [loading, setLoading] = useState(false);
  const [error, showError] = useState(false);
  const [secret, setSecret] = useState('');
  const { key, password } = useParams<DisplayParams>();
  const { t } = useTranslation();
  const location = useLocation();
  const isEncoded = null !== location.pathname.match(/\/c\//);

  const decrypt = useCallback(async () => {
    if (!password) {
      return;
    }
    setLoading(true);
    const url = process.env.REACT_APP_BACKEND_URL
      ? `${process.env.REACT_APP_BACKEND_URL}/secret`
      : '/secret';
    try {
      const request = await fetch(`${url}/${key}`);
      if (request.status === 200) {
        const data = await request.json();
        const r = await decryptMessage(
          data.message,
          isEncoded ? atob(password) : password,
          'utf8',
        );
        setSecret(r.data as string);
        setLoading(false);
        return;
      }
    } catch (e) {
      console.log(e);
    }
    setLoading(false);
    showError(true);
  }, [isEncoded, password, key]);

  useEffect(() => {
    decrypt();
  }, [decrypt]);

  return (
    <div>
      {loading && (
        <h3>
          {t(
            'Fetching from database and decrypting in browser, please hold...',
          )}
        </h3>
      )}
      <Error display={error} />
      <Secret secret={secret} />
      <Form display={!password} uuid={key} prefix={isEncoded ? 'c' : 's'} />
    </div>
  );
};

const Secret = (
  props: { readonly secret: string } & React.HTMLAttributes<HTMLElement>,
) => {
  const { t } = useTranslation();
  new Clipboard('#copy-b', {
    target: () => document.getElementById('pre') as Element,
  });

  return props.secret ? (
    <div>
      <h1>{t('Decrypted Message')}</h1>
      {t('This secret might not be viewable again, make sure to save it now!')}
      <Button id="copy-b" color="primary" className="copy-secret-button">
        <FontAwesomeIcon icon={faCopy} /> {t('Copy')}
      </Button>
      <pre id="pre">{props.secret}</pre>
    </div>
  ) : null;
};

export default DisplaySecret;
