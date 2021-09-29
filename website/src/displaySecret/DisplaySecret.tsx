import { useEffect, useState } from 'react';
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

const EnterDecryptionKey = ({
  setPassword,
  password,
}: {
  setPassword: (password: string) => any;
  readonly password: string;
}) => {
  const { t } = useTranslation();
  const [tempPassword, setTempPassword] = useState(password);
  const invalidPassword = !!password;

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
            value={tempPassword}
            error={invalidPassword}
            helperText={invalidPassword && t('display.errorInvalidPassword')}
            onChange={(e) => setTempPassword(e.target.value)}
            inputProps={{ spellCheck: 'false', 'data-gramm': 'false' }}
          />
        </Grid>
        <Grid item xs={12}>
          <Button variant="contained" onClick={() => setPassword(tempPassword)}>
            {t('display.buttonDecrypt')}
          </Button>
        </Grid>
      </Grid>
    </Container>
  );
};

interface secretState {
  decrypting: boolean;
  failed: boolean;
  filename?: string;
  data?: string;
}

const DisplaySecret = () => {
  const { t } = useTranslation();
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
  const url = isFile
    ? `${backendDomain}/file/${key}`
    : `${backendDomain}/secret/${key}`;

  const [password, setPassword] = useState(paramsPassword);
  const [loadSecret, setLoadSecret] = useState(!!password);
  const [secretInfo, setSecretInfo] = useState({} as secretState);

  // Ensure that we unload the password when this param changes
  useEffect(() => {
    setSecretInfo({} as secretState);
    setPassword(paramsPassword);
    setLoadSecret(!!paramsPassword);
  }, [paramsPassword]);

  // Ensure that we unload the secret when the key changes
  useEffect(() => {
    setSecretInfo({} as secretState);
    setLoadSecret(!!password);
  }, [key]);

  // Load the secret data when required
  const { data, error } = useSWR(loadSecret ? url : null, fetcher, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  // Decrypt the secret if password or data is changed
  useAsync(async () => {
    if (!data || !password) {
      return;
    }

    let res = { decrypting: true } as secretState;
    setSecretInfo(res);
    try {
      const r = await decryptMessage(
        data,
        password,
        isFile ? 'binary' : 'utf8',
      );

      if (isFile) {
        res.filename = r.filename;
      }
      res.data = r.data as string;
    } catch (e) {
      res.failed = true;
    } finally {
      res.decrypting = false;
      setSecretInfo(res);
    }
  }, [password, data]);

  // Handle the loaded of the secret
  if (loadSecret) {
    if (error) {
      return <ErrorPage error={error} />;
    }
    if (!data) {
      return <Typography variant="h4">{t('display.titleFetching')}</Typography>;
    }
  }

  // Handle the decrypting
  if (secretInfo.decrypting) {
    return <Typography variant="h4">{t('display.titleDecrypting')}</Typography>;
  }
  if (secretInfo.failed) {
    return <EnterDecryptionKey password={password} setPassword={setPassword} />;
  }
  if (secretInfo.data) {
    return <Secret secret={secretInfo.data} fileName={secretInfo.filename} />;
  }

  // If there is no password we need to fetch it.
  return (
    <EnterDecryptionKey
      password=""
      setPassword={(password: string) => {
        setPassword(password);
        setLoadSecret(true);
      }}
    />
  );
};

export default DisplaySecret;
