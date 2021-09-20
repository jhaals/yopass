import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Button, Typography, makeStyles } from '@material-ui/core';
import { useCopyToClipboard } from 'react-use';
import { saveAs } from 'file-saver';
import { useEffect } from 'react';

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

  useEffect(() => {
    fileName &&
      saveAs(
        new Blob([secret], {
          type: 'application/octet-stream',
        }),
        fileName,
      );
  }, [fileName, secret]);

  if (fileName) {
    return (
      <div>
        <Typography variant="h4">{t('secret.titleFile')}</Typography>
      </div>
    );
  }
  return (
    <div>
      <Typography variant="h4">{t('secret.titleMessage')}</Typography>
      <Typography>{t('secret.subtitleMessage')}</Typography>
      <Button
        color={copy.error ? 'secondary' : 'primary'}
        onClick={() => copyToClipboard(secret)}
      >
        <FontAwesomeIcon icon={faCopy} /> {t('secret.buttonCopy')}
      </Button>
      <pre data-test-id="secret" id="pre" className={classes.pre}>
        {secret}
      </pre>
    </div>
  );
};

export default Secret;
