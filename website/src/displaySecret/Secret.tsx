import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Button } from 'reactstrap';
import { useCopyToClipboard } from 'react-use';

const Secret = (props: { readonly secret?: string }) => {
  const { t } = useTranslation();
  const [copy, copyToClipboard] = useCopyToClipboard();

  if (props.secret === undefined) {
    return null;
  }
  const secret = props.secret;

  return (
    <div>
      <h1>{t('Decrypted Message')}</h1>
      {t('This secret might not be viewable again, make sure to save it now!')}
      <Button
        color={copy.error ? 'danger ' : 'primary'}
        className="copy-secret-button"
        onClick={() => copyToClipboard(secret)}
      >
        <FontAwesomeIcon icon={faCopy} /> {t('Copy')}
      </Button>
      <pre id="pre">{secret}</pre>
    </div>
  );
};

export default Secret;
