import * as React from 'react';
import { useTranslation } from 'react-i18next';

type ErrorProps = {
  readonly error?: Error;
};

const Error: React.FC<ErrorProps> = (props) => {
  const { t } = useTranslation();

  if (props.error === undefined) {
    return null;
  }

  return (
    <div>
      <h2>{t('Secret does not exist')}</h2>
      <p className="lead">{t('It might be caused by any of these reasons.')}</p>
      <h4>{t('Opened before')}</h4>
      {t(
        'A secret can be restricted to a single download. It might be lost because the sender clicked this link before you viewed it.',
      )}
      <p>
        {t(
          'The secret might have been compromised and read by someone else. You should contact the sender and request a new secret.',
        )}
      </p>
      <h4>{t('Broken link')}</h4>
      <p>
        {t(
          'The link must match perfectly in order for the decryption to work, it might be missing some magic digits.',
        )}
      </p>
      <h4>{t('Expired')}</h4>
      <p>
        {t(
          'No secret last forever. All stored secrets will expires and self destruct automatically. Lifetime varies from one hour up to one week.',
        )}
      </p>
    </div>
  );
};
export default Error;
