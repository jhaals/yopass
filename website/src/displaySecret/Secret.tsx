import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Button, Typography, makeStyles } from '@material-ui/core';
import { useCopyToClipboard } from 'react-use';
import { saveAs } from 'file-saver';

const useStyles = makeStyles(() => ({
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

const Secret = ({
  secret,
  fileName,
}: {
  readonly secret: string;
  readonly fileName?: string;
}) => {
  const { t } = useTranslation();
  const [copy, copyToClipboard] = useCopyToClipboard();
  const classes = useStyles();

  if (fileName) {
    saveAs(
      new Blob([secret], {
        type: 'application/octet-stream',
      }),
      fileName,
    );
    return (
      <div>
        <Typography variant="h4">{t('File downloaded')}</Typography>
      </div>
    );
  }
  return (
    <div>
      <Typography variant="h4">{t('Decrypted Message')}</Typography>
      <Typography>
        {t(
          'This secret might not be viewable again, make sure to save it now!',
        )}
      </Typography>
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
