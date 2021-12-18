import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { Button, Typography } from '@mui/material';
import { useAsync, useCopyToClipboard } from 'react-use';
import { saveAs } from 'file-saver';
import { useEffect, useState } from 'react';
import { decryptMessage } from '../utils';
import { useRouter } from 'next/router';
import EnterDecryptionKey from './EnterDecryptionKey';
import DeleteSecret from './DeleteSecret';

const RenderSecret = ({ secret }: { readonly secret: string }) => {
  const { t } = useTranslation();
  const [copy, copyToClipboard] = useCopyToClipboard();

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
          fontFamily: 'monospace, monospace', // https://github.com/necolas/normalize.css/issues/519#issuecomment-197131966
        }}
      >
        {secret}
      </Typography>
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

type SecretProps = {
  data: any;
  password: string;
};

const Secret = ({ data, password: passwordProp }: SecretProps) => {
  const router = useRouter();
  const { t } = useTranslation();
  const isFile = router.pathname.startsWith('/f');
  const [password, setPassword] = useState(passwordProp);
  const { loading, error, value } = useAsync(async () => {
    return await decryptMessage(
      data.message,
      password,
      isFile ? 'binary' : 'utf8',
    );
  }, [password]);

  if (error) {
    console.log(error);
    return (
      <EnterDecryptionKey
        password={password}
        setPassword={(password: string) => {
          setPassword(password);
        }}
      />
    );
  }
  if (loading) {
    return <Typography variant="h4">{t('display.titleDecrypting')}</Typography>;
  }
  if (value.filename) {
    return (
      <DownloadSecret fileName={value.filename} secret={value.data as string} />
    );
  }
  return (
    <>
      <RenderSecret secret={value.data as string} />
      {!data.one_time && <DeleteSecret />}
    </>
  );
};

export default Secret;
