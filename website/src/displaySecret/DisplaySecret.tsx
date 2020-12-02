import * as React from 'react';
import { useLocation, useParams } from 'react-router-dom';
import Error from './Error';
import Form from '../createSecret/Form';
import { backendDomain, decryptMessage } from '../utils/utils';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Button } from 'reactstrap';
import Clipboard from 'clipboard';
import { useAsync } from 'react-use';

const DisplaySecret: React.FC = () => {
  const { key, password } = useParams<DisplayParams>();
  const { t } = useTranslation();
  const location = useLocation();
  const isEncoded = null !== location.pathname.match(/\/c\//);

  const state = useAsync(async () => {
    if (password === undefined) {
      return;
    }
    const request = await fetch(`${backendDomain}/secret/${key}`);
    const data = await request.json();
    const r = await decryptMessage(
      data.message,
      isEncoded ? atob(password) : password,
      'utf8',
    );
    return r.data as string;
  }, [isEncoded, password, key]);

  return (
    <div>
      {state.loading && (
        <h3>
          {t(
            'Fetching from database and decrypting in browser, please hold...',
          )}
        </h3>
      )}
      {state.error && <Error display={state.error !== undefined} />}
      {state.value && <Secret secret={state.value} />}
      <Form display={!password} uuid={key} prefix={isEncoded ? 'c' : 's'} />
    </div>
  );
};

type SecretProps = {
  readonly secret: string;
};

const Secret: React.FC<SecretProps> = (props) => {
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
