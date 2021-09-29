import { useState } from 'react';
import { useParams } from 'react-router-dom';
import useSWR from 'swr';
import { backendDomain, decryptMessage } from '../utils/utils';
import Secret from './Secret';
import ErrorPage from './Error';
import {
  Container,
  Grid,
  TextField,
  Button,
  Typography,
} from '@material-ui/core';
import { useTranslation } from 'react-i18next';
import { useAsync } from 'react-use';

const fetcher = async (url: string) => {
  const request = await fetch(url);
  if (!request.ok) {
    throw new Error('Failed to fetch secret');
  }
  const data = await request.json();
  return data.message;
};

const RequestDecryptionKey = ({
  decryptData,
  paramsPassword,
}: {
  decryptData: (password: string) => any;
  readonly paramsPassword: string;
}) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState(paramsPassword);
  const [invalidPassword, setInvalidPassword] = useState(!!paramsPassword);

  const decrypt = async () => {
    if (!password) {
      return;
    }
    const res = await decryptData(password);
    setInvalidPassword(res === false);
  };

  return (
    <Container maxWidth="lg">
      <Grid container direction="column" spacing={1}>
        <Grid item xs={12}>
          <Typography variant="h5">
            {t('display.titleDecryptionKey')}
          </Typography>
          <Typography variant="caption">
            {t('display.captionDecryptionKey')}
          </Typography>
        </Grid>
        <Grid item xs={12}>
          <TextField
            fullWidth
            autoFocus
            name="decryptionKey"
            id="decryptionKey"
            placeholder={t('display.inputDecryptionKeyPlaceholder')}
            label={t('display.inputDecryptionKeyLabel')}
            value={password}
            error={invalidPassword}
            helperText={invalidPassword && t('display.errorInvalidPassword')}
            onChange={(e) => setPassword(e.target.value)}
            inputProps={{ spellCheck: 'false', 'data-gramm': 'false' }}
          />
        </Grid>
        <Grid item xs={12}>
          <Button variant="contained" onClick={decrypt}>
            {t('display.buttonDecrypt')}
          </Button>
        </Grid>
      </Grid>
    </Container>
  );
};

const DisplaySecret = () => {
  const {
    format,
    key,
    password: paramsPassword,
  } = useParams<{
    format: string;
    key: string;
    password: string;
  }>();
  const isFile = format === 'f';
  const [decrypting, setDecrypting] = useState(false);
  const [secret, setSecret] = useState('');
  const [fileName, setFileName] = useState('');
  const { t } = useTranslation();

  const url = isFile
    ? `${backendDomain}/file/${key}`
    : `${backendDomain}/secret/${key}`;
  const { data, error } = useSWR(url, fetcher, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  useAsync(async () => {
    return decrypt(paramsPassword);
  }, [paramsPassword, data]);

  const decrypt = async (password: string) => {
    if (!data || !password) {
      return;
    }

    setDecrypting(true);
    try {
      const r = await decryptMessage(
        data,
        password,
        isFile ? 'binary' : 'utf8',
      );
      if (isFile) {
        setFileName(r.filename);
      }
      setSecret(r.data as string);
    } catch (e) {
      return false;
    } finally {
      setDecrypting(false);
    }

    return true;
  };

  if (error) {
    return <ErrorPage error={error} />;
  }
  if (!data) {
    return <Typography variant="h4">{t('display.titleFetching')}</Typography>;
  }
  if (decrypting) {
    return <Typography variant="h4">{t('display.titleDecrypting')}</Typography>;
  }

  if (secret) {
    return <Secret secret={secret} fileName={fileName} />;
  }
  return (
    <RequestDecryptionKey
      paramsPassword={paramsPassword}
      decryptData={decrypt}
    />
  );
};

export default DisplaySecret;
