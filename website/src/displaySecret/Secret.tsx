import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Button, Typography, makeStyles } from '@material-ui/core';
import { useCopyToClipboard } from 'react-use';

const useStyles = makeStyles((theme) => ({
  pre: {
    backgroundColor: '#ecf0f1',
    padding: '15px',
    border: '1px solid #cccccc',
    display: 'block',
    fontSize: '14px',
    borderRadius: '4px',
    wordWrap: 'break-word',
    wordBreak: 'break-all',
  },
}));

const Secret = (props: { readonly secret?: string }) => {
  const { t } = useTranslation();
  const [copy, copyToClipboard] = useCopyToClipboard();
  const classes = useStyles();

  if (props.secret === undefined) {
    return null;
  }
  const secret = props.secret;

  return (
    <div>
      <Typography variant={'h2'}>{t('Decrypted Message')}</Typography>
      {t('This secret might not be viewable again, make sure to save it now!')}
      <Button
        color={copy.error ? 'secondary' : 'primary'}
        onClick={() => copyToClipboard(secret)}
      >
        <FontAwesomeIcon icon={faCopy} /> {t('Copy')}
      </Button>
      <pre id="pre" className={classes.pre}>
        {secret}
      </pre>
    </div>
  );
};

export default Secret;
