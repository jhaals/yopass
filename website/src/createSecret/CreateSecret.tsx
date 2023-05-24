import { useTranslation } from 'react-i18next';
import { useForm, UseFormMethods } from 'react-hook-form';
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
  InputLabel,
  FormGroup,
  FormControlLabel,
  Checkbox,
} from '@material-ui/core';
import { useAuth } from 'oidc-react';

const CreateSecret = () => {
  const { t } = useTranslation();
  const { control, register, errors, handleSubmit, setError, clearErrors } =
    useForm({
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
        access_token: auth?.userData?.access_token,
      });

      if (status !== 200) {
        setError('secret', { type: 'submit', message: data.message });
      } else {
        setResult({
          password: pw,
          uuid: data.message,
        });
      }
    } catch (e: any) {
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

  function log(data: string, data2: string = '') {
    console.log(data + ' ' + data2);
  }

  // If you’re familiar with React class lifecycle methods,
  // you can think of useEffect Hook as
  // componentDidMount, componentDidUpdate, and componentWillUnmount combined.
  // https://reactjs.org/docs/hooks-effect.html
  useEffect(() => {
    if (isUserLoggedOut) {
      console.log('User logged out!');
      return signIn();
    } else {
      console.log('User logged in....');
    }

    if (auth?.userData?.expired === true) {
      log('Access token expired!');
      auth.userManager
        .signinSilent()
        .then(function () {
          log('silent renew success');
        })
        .catch(function (err: any) {
          log('silent renew error', err);
          auth.userManager.signinRedirect();
        });
    } else {
      log('Access token not expired....');
    }
  });

  if (result.uuid) {
    return <Result password={result.password} uuid={result.uuid} prefix="s" />;
  }

  return (
    <>
      <Error
        message={errors.secret?.message}
        onClick={() => clearErrors('secret')}
      />
      <Typography component="h1" variant="h4" align="center">
        {t('create.title')}
      </Typography>

      {!isUserLoggedOut && (
        <Typography
          data-test-id="userEmail"
          align="center"
          style={{
            fontFamily: 'Red Hat Text, sans-serif',
            padding: '.5em 0em',
          }}
        >
          {auth.userData?.profile.email}
        </Typography>
      )}

      <form onSubmit={handleSubmit(onSubmit)}>
        <Grid container justifyContent="center" paddingTop={1}>
          <TextField
            inputRef={register({ required: true })}
            multiline={true}
            name="secret"
            margin="dense"
            fullWidth
            label={t('create.inputSecretLabel')}
            rows="4"
            autoFocus={true}
            onKeyDown={onKeyDown}
            placeholder={t('create.inputSecretPlaceholder')}
            inputProps={{
              'data-test-id': 'inputSecret',
              spellCheck: 'false',
              'data-gramm': 'false',
            }}
          />
          <Grid container justifyContent="center" marginTop={2}>
            <Expiration control={control} />
          </Grid>
          <Grid container justifyContent="center">
            <Box p={2} pb={4}>
              <Button
                data-test-id="encryptSecret"
                variant="contained"
                disabled={loading}
              >
                {loading ? (
                  <span>{t('create.buttonEncryptLoading')}</span>
                ) : (
                  <span>{t('create.buttonEncrypt')}</span>
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

export const OneTime = (props: { register: UseFormMethods['register'] }) => {
  const { t } = useTranslation();
  return (
    <Grid item justifyContent="center">
      <FormControlLabel
        control={
          <Checkbox
            id="enable-onetime"
            name="onetime"
            inputRef={props.register()}
            defaultChecked={true}
            color="primary"
          />
        }
        label={t('create.inputOneTimeLabel')}
      />
    </Grid>
  );
};

export const SpecifyPasswordInput = (props: {
  register: UseFormMethods['register'];
}) => {
  const { t } = useTranslation();
  return (
    <Grid item justifyContent="center">
      <InputLabel>{t('create.inputPasswordLabel')}</InputLabel>
      <TextField
        fullWidth
        type="text"
        id="password"
        inputRef={props.register()}
        name="password"
        variant="outlined"
        inputProps={{
          autoComplete: 'off',
          spellCheck: 'false',
          'data-gramm': 'false',
        }}
      />
    </Grid>
  );
};

export const SpecifyPasswordToggle = (props: {
  register: UseFormMethods['register'];
}) => {
  const { t } = useTranslation();
  return (
    <FormGroup>
      <FormControlLabel
        control={
          <Checkbox
            name="generateDecryptionKey"
            inputRef={props.register()}
            defaultChecked={true}
            color="primary"
          />
        }
        label={t('create.inputGenerateLabel')}
      />
    </FormGroup>
  );
};

export default CreateSecret;
