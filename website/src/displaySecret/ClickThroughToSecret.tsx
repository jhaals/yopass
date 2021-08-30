import { useState } from 'react';
import { generatePath, useHistory, useParams } from 'react-router-dom';
import {
  Button,
  Container,
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import { useTranslation } from 'react-i18next';

const ClickThroughToSecret = () => {
  const { format, key, password: paramsPassword } = useParams<{
    format: string;
    key: string;
    password: string;
  }>();
  const isFile = format === 'f';
  const { t } = useTranslation();
  const history = useHistory();

  const [password, setPassword] = useState('');
  const [invalidPassword, setInvalidPassword] = useState(false);

  // The state can go out of sync when using back buttons
  // So to ensure that password is using the correct version set the url password when it exists
  if (!password && paramsPassword) {
    setPassword(paramsPassword);
  }

  const toSecret = () => {
    if (!password) {
      setInvalidPassword(true);
      return;
    }
    const pathname = generatePath('/:format(s|f)/:key/:password', {
      format: format,
      key: key,
      password: password,
    });

    history.push({ pathname: pathname, state: {} });
  };

  return (
    <Container maxWidth="lg">
      <Grid container direction="column" spacing={1}>
        {!paramsPassword && (
          <>
            <Grid item xs={12}>
              <Typography variant="h5">
                {t('display.titleDecryptionKey')}
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
                helperText={
                  invalidPassword && t('display.errorInvalidPassword')
                }
                onChange={(e) => setPassword(e.target.value)}
                inputProps={{ spellCheck: 'false', 'data-gramm': 'false' }}
              />
            </Grid>
          </>
        )}
        <Grid item xs={12}>
          <Button variant="contained" onClick={toSecret}>
            {isFile
              ? t('click-through.buttonSecret')
              : t('click-through.buttonFile')}
          </Button>
        </Grid>
      </Grid>
    </Container>
  );
};

export default ClickThroughToSecret;
