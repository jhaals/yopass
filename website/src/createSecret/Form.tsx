import { useState, FC } from 'react';
import { Redirect } from 'react-router-dom';
import { Button, Container, Grid, TextField } from '@material-ui/core';
import { useTranslation } from 'react-i18next';

type FormProps = {
  readonly display: boolean;
  readonly uuid: string | undefined;
  readonly prefix: string;
};

const Form: FC<FormProps> = (props) => {
  const [password, setPassword] = useState('');
  const [redirect, setRedirect] = useState(false);
  const { t } = useTranslation();

  const doRedirect = (): void => {
    if (password) {
      setRedirect(true);
    }
  };

  if (redirect) {
    if (props.prefix === 'c' || props.prefix === 'd') {
      // Base64 encode the password to support special characters
      return (
        <Redirect to={`/${props.prefix}/${props.uuid}/${btoa(password)}`} />
      );
    }

    return <Redirect to={`/${props.prefix}/${props.uuid}/${password}`} />;
  }
  return props.display ? (
    <Container maxWidth="lg">
      <Grid container={true} direction={'column'} spacing={5}>
        <Grid item={true} xs={12}>
          <TextField
            fullWidth={true}
            autoFocus={true}
            name="decryptionKey"
            id="decryptionKey"
            placeholder={t('Decryption Key')}
            label={t('A decryption key is required, please enter it below')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Grid>
        <Grid item={true} xs={12}>
          <Button variant="contained" onClick={doRedirect}>
            {t('Decrypt Secret')}
          </Button>
        </Grid>
      </Grid>
    </Container>
  ) : null;
};
export default Form;
