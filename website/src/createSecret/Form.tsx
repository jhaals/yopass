import { useState } from 'react';
import { Redirect } from 'react-router-dom';
import { Button, Container, Grid, TextField } from '@material-ui/core';
import { useTranslation } from 'react-i18next';

type FormProps = {
  readonly uuid: string;
  readonly prefix: string;
};

const Form = ({ uuid, prefix }: FormProps) => {
  const [password, setPassword] = useState('');
  const [redirect, setRedirect] = useState(false);
  const { t } = useTranslation();

  const doRedirect = (): void => {
    if (password) {
      setRedirect(true);
    }
  };

  if (redirect) {
    if (prefix === 'c' || prefix === 'd') {
      // Base64 encode the password to support special characters
      return <Redirect to={`/${prefix}/${uuid}/${btoa(password)}`} />;
    }
    return <Redirect to={`/${prefix}/${uuid}/${password}`} />;
  }

  return (
    <Container maxWidth="lg">
      <Grid container direction={'column'} spacing={5}>
        <Grid item xs={12}>
          <TextField
            fullWidth
            autoFocus
            name="decryptionKey"
            id="decryptionKey"
            placeholder={t('Decryption Key')}
            label={t('A decryption key is required, please enter it below')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Grid>
        <Grid item xs={12}>
          <Button variant="contained" onClick={doRedirect}>
            {t('Decrypt Secret')}
          </Button>
        </Grid>
      </Grid>
    </Container>
  );
};
export default Form;
