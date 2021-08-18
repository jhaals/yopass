import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import randomString, { encryptMessage, postSecret } from '../utils/utils';
import { useEffect, useState } from 'react';
import Result from '../displaySecret/Result';
import Expiration from './../shared/Expiration';
import {
  Alert,
  TextField,
  Typography,
  Button,
  Grid,
  Box,
} from '@material-ui/core';
import { useAuth } from 'oidc-react';

const CreateSecret = () => {
  const { t } = useTranslation();
  const {
    control,
    register,
    errors,
    handleSubmit,
    setError,
    clearErrors,
  } = useForm({
    defaultValues: {
      generateDecryptionKey: true,
      secret: '',
    },
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState({
    password: '',
    uuid: '',
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.ctrlKey && event.key === 'Enter') {
      handleSubmit(onSubmit)();
    }
  };

  const onSubmit = async (form: any): Promise<void> => {
    // Use the manually entered password, or generate one
    const pw = randomString();
    setLoading(true);
    try {
      const { data, status } = await postSecret({
        expiration: parseInt(form.expiration),
        message: await encryptMessage(form.secret, pw),
        one_time: true,
      });

      if (status !== 200) {
        setError('secret', { type: 'submit', message: data.message });
      } else {
        setResult({
          password: pw,
          uuid: data.message,
        });
      }
    } catch (e) {
      setError('secret', { type: 'submit', message: e.message });
    }
    setLoading(false);
  };

  var auth = useAuth();

  var isUserLoggedOut = !auth?.userData;

  var username = auth?.userData?.profile?.username;
  console.log(username);

  var signIn = () => {
    if (!auth) {
      console.error('Unknown sign-in error.');
      return;
    }

    // var login = isUserLoggedOut ? auth.signIn : auth.signOut;
    var login = auth.signIn;

    login().then(console.log).catch(console.error);
  };

  // If you’re familiar with React class lifecycle methods,
  // you can think of useEffect Hook as
  // componentDidMount, componentDidUpdate, and componentWillUnmount combined.
  // https://reactjs.org/docs/hooks-effect.html
  useEffect(() => {
    if (isUserLoggedOut) {
      return signIn();
    }
  });

  if (result.uuid) {
    return (
      <Result
        password={result.password}
        uuid={result.uuid}
        prefix="s"
      />
    );
  }

  return (
    <>
      <Error
        message={errors.secret?.message}
        onClick={() => clearErrors('secret')}
      />
      <Typography component="h1" variant="h4" align="center">
        {t('Encrypt message')}
      </Typography>
      <form onSubmit={handleSubmit(onSubmit)}>
        <Grid container justifyContent="center" paddingTop={1}>
          <TextField
            inputRef={register({ required: true })}
            multiline={true}
            name="secret"
            margin="dense"
            fullWidth
            label={t('Secret message')}
            rows="4"
            autoFocus={true}
            onKeyDown={onKeyDown}
            placeholder={t('Message to encrypt locally in your browser')}
            // eslint-disable-next-line no-useless-computed-key
            inputProps={{ spellCheck: 'false', ['data-gramm']: 'false' }}
          />
          <Grid container justifyContent="center" marginTop={2}>
            <Expiration control={control} />
          </Grid>
          <Grid container justifyContent="center">
            <Box p={2} pb={4}>
              <Button variant="contained" disabled={loading}>
                {loading ? (
                  <span>{t('Encrypting message...')}</span>
                ) : (
                  <span>{t('Encrypt Message')}</span>
                )}
              </Button>
            </Box>
          </Grid>
        </Grid>
      </form>
    </>
  );
};

export const Error = (props: { message?: string; onClick?: () => void }) =>
  props.message ? (
    <Alert severity="error" {...props}>
      {props.message}
    </Alert>
  ) : null;

export default CreateSecret;
