import { Container, Grid, Typography, TextField, Button } from '@mui/material';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const EnterDecryptionKey = ({
  setPassword,
  password,
  loaded,
}: {
  setPassword: (password: string) => any;
  readonly password?: string;
  readonly loaded?: boolean;
}) => {
  const { t } = useTranslation();
  const [tempPassword, setTempPassword] = useState(password);
  const invalidPassword = !!password;

  const submitPassword = () => {
    if (tempPassword) {
      setPassword(tempPassword);
    }
  };
  return (
    <Container maxWidth="lg">
      <Grid container direction="column" spacing={1}>
        <Grid item xs={12}>
          <Typography variant="h5">
            {t('display.titleDecryptionKey')}
          </Typography>
          {loaded && (
            <Typography variant="caption">
              {t('display.captionDecryptionKey')}
            </Typography>
          )}
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
          <Button variant="contained" onClick={submitPassword}>
            {t('display.buttonDecrypt')}
          </Button>
        </Grid>
      </Grid>
    </Container>
  );
};
export default EnterDecryptionKey;
