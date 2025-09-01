import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Box, Button, Paper, Typography, useTheme } from '@mui/material';
import { useCopyToClipboard } from 'react-use';
import { saveAs } from 'file-saver';
import { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';

const RenderSecret = ({ secret }: { readonly secret: string }) => {
  const { t } = useTranslation();
  const [copy, copyToClipboard] = useCopyToClipboard();
  const [showQr, setShowQr] = useState(false);
  const { palette } = useTheme();
  // Do not display QR code if the secret is too long
  const displayQR = secret.length < 500;

  return (
    <div>
      <Typography variant="h4">{t('secret.titleMessage')}</Typography>
      <Typography>{t('secret.subtitleMessage')}</Typography>
      <Button
        color={copy.error ? 'secondary' : 'primary'}
        onClick={() => copyToClipboard(secret)}
        startIcon={<FontAwesomeIcon icon={faCopy} size="xs" />}
      >
        {t('secret.buttonCopy')}
      </Button>
      <Paper variant="outlined">
        <Typography
          id="pre"
          data-test-id="preformatted-text-secret"
          sx={{
            padding: '15px',
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
      </Paper>
      {displayQR && (
        <Button onClick={() => setShowQr(!showQr)}>
          {showQr ? t('secret.hideQrCode') : t('secret.showQrCode')}
        </Button>
      )}
      <Box
        sx={{
          display: showQr ? 'flex' : 'none',
          justifyContent: 'center',
          alignItems: 'center',
          margin: 5,
        }}
      >
        {displayQR && (
          <QRCode
            bgColor={palette.background.default}
            fgColor={palette.text.primary}
            size={150}
            style={{ height: 'auto' }}
            value={secret}
          />
        )}
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
