import { useState } from 'react';
import { useParams } from 'react-router-dom';
import useSWR from 'swr';
import { backendDomain, decryptMessage } from '../utils/utils';
import Secret from './Secret';
import ErrorPage from './Error';
import { Container, Grid, TextField, Button, Typography } from '@mui/material';
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
  const [password, setPassword] = useState(
    paramsPassword ? paramsPassword : '',
  );
  const [secret, setSecret] = useState('');
  const [fileName, setFileName] = useState('');
  const [invalidPassword, setInvalidPassword] = useState(false);
  const { t } = useTranslation();

  const url = isFile
    ? `${backendDomain}/file/${key}`
    : `${backendDomain}/secret/${key}`;
  const { data, error } = useSWR(url, fetcher, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  useAsync(async () => {
    return decrypt();
  }, [paramsPassword, data]);

  const decrypt = async () => {
    if (!data || !password) {
      return;
    }
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
      setInvalidPassword(true);
      return false;
    }
    return true;
  };

  if (error) return <ErrorPage error={error} />;
  if (!data)
    return <Typography variant="h4">{t('display.titleFetching')}</Typography>;
  if (secret) {
    return <Secret secret={secret} fileName={fileName} />;
  }
  if (paramsPassword && !secret && !invalidPassword) {
    return <Typography variant="h4">{t('display.titleDecrypting')}</Typography>;
  }

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
            placeholder={t<string>('display.inputDecryptionKeyPlaceholder')}
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

export default DisplaySecret;
