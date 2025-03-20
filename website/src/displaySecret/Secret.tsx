import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Box, Button, Typography } from '@mui/material';
import { useCopyToClipboard } from 'react-use';
import { saveAs } from 'file-saver';
import { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';

const RenderSecret = ({ secret }: { readonly secret: string }) => {
  const { t } = useTranslation();
  const [copy, copyToClipboard] = useCopyToClipboard();
  const [showQr, setShowQr] = useState(false);

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
      <Typography
        id="pre"
        data-test-id="preformatted-text-secret"
        sx={{
          backgroundColor: '#ecf0f1',
          padding: '15px',
          border: '1px solid #cccccc',
          display: 'block',
          fontSize: '1rem',
          borderRadius: '4px',
          wordWrap: 'break-word',
          wordBreak: 'break-all',
          whiteSpace: 'pre-wrap',
          fontFamily: 'monospace, monospace', // https://github.com/necolas/normalize.css/issues/519#issuecomment-197131966
        }}
      >
        {secret}
      </Typography>
      <Button onClick={() => setShowQr(!showQr)}>
        {showQr ? t('secret.hideQrCode') : t('secret.showQrCode')}
      </Button>
      <Box
        sx={{
          display: showQr ? 'flex' : 'none',
          justifyContent: 'center',
          alignItems: 'center',
          margin: 5,
        }}
      >
        <QRCode size={150} style={{ height: 'auto' }} value={secret} />
      </Box>
    </div>
  );
};

const DownloadSecret = ({
  secret,
  fileName,
}: {
  readonly secret: string;
  readonly fileName: string;
}) => {
  const { t } = useTranslation();

  useEffect(() => {
    saveAs(
      new Blob([secret], {
        type: 'application/octet-stream',
      }),
      fileName,
    );
  }, [fileName, secret]);

  return (
    <div>
      <Typography variant="h4">{t('secret.titleFile')}</Typography>
    </div>
  );
};

const Secret = ({
  secret,
  fileName,
}: {
  readonly secret: string;
  readonly fileName?: string;
}) => {
  if (fileName) {
    return <DownloadSecret fileName={fileName} secret={secret} />;
  }

  return <RenderSecret secret={secret} />;
};

export default Secret;
