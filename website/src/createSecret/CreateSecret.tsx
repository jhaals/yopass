import { useTranslation } from 'react-i18next';
import { useForm, Controller, Control } from 'react-hook-form';
import randomString, {
  encryptMessage,
  isErrorWithMessage,
  postSecret,
} from '../utils/utils';
import { useState } from 'react';
import Result from '../displaySecret/Result';
import Error from '../shared/Error';
import Expiration from '../shared/Expiration';
import {
  Checkbox,
  FormGroup,
  FormControlLabel,
  TextField,
  Typography,
  Button,
  Grid,
  Box,
  InputLabel,
} from '@mui/material';
import { faThList } from '@fortawesome/free-solid-svg-icons';
import { Form } from 'react-router-dom';
import Secret from '../displaySecret/Secret';

const CreateSecret = () => {
  const { t } = useTranslation();
  const {
    control,
    formState: { errors },
    handleSubmit,
    watch,
    setError,
    clearErrors,
  } = useForm({
    defaultValues: {
      generateDecryptionKey: true,
      secret: '',
      onetime: true,
    },
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState({
    password: '',
    uuid: '',
    customPassword: false,
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.ctrlKey && event.key === 'Enter') {
      handleSubmit(onSubmit)();
    }
  };

  const [secret, setSecret] = useState("");

  const generatePassword = async (form: any): Promise<void> => {
    try {
      const fetched = await fetch("https://makemeapassword.ligos.net/api/v1/alphanumeric/json");
      const temp = await fetched.json();
      setSecret(temp["pws"][0]);
    }
    catch(e) {
      console.log(e);
      setSecret(randomString());
    }
  } 

  const onSubmit = async (form: any): Promise<void> => {
    // Use the manually entered password, or generate one
    const pw = form.password ? form.password : randomString();
    setLoading(true);
    try {
      const { data, status } = await postSecret({
        expiration: parseInt(form.expiration),
        message: await encryptMessage(secret, pw),
        one_time: form.onetime,
      });
      
      if (status !== 200) {
        setError('secret', { type: 'submit', message: data.message });
      } else {
        setResult({
          customPassword: form.password ? true : false,
          password: pw,
          uuid: data.message,
        });
      }
    } catch (e) {
      if (isErrorWithMessage(e)) {
        setError('secret', {
          type: 'submit',
          message: e.message,
        });
      }
    }
    setLoading(false);
  };

  const generateDecryptionKey = watch('generateDecryptionKey');

  if (result.uuid) {
    return (
      <Result
        password={result.password}
        uuid={result.uuid}
        prefix="s"
        customPassword={result.customPassword}
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
        {t('create.title')}
      </Typography>
      <form onSubmit={handleSubmit(onSubmit)}>
        <Grid container justifyContent="center" paddingTop={1}>
          <Controller
            name="secret"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                multiline={true}
                margin="dense"
                fullWidth
                label={t('create.inputSecretLabel')}
                rows="4"
                autoFocus={true}
                onKeyDown={onKeyDown}
                placeholder="..."
                inputProps={{ spellCheck: 'false', 'data-gramm': 'false' }}
                value={secret}
                onChange={e => setSecret(e.target.value)}
              />
            )}
          />
          <Grid container justifyContent="center" marginTop={2}>
            <Expiration control={control} />
          </Grid>
          <Grid container alignItems="center" direction="column">
            <OneTime control={control} />
            <SpecifyPasswordToggle control={control} />
            {!generateDecryptionKey && (
              <SpecifyPasswordInput control={control} />
            )}
          </Grid>
          <Grid container justifyContent="center">
            <Box p={2} pb={4}>
              <Button
                onClick={() => handleSubmit(generatePassword)()}
                variant="contained"
                disabled={loading}
                sx={{ 
                  borderRadius: "20px",
                  backgroundImage: "linear-gradient(45deg,#0096bb,#6cbe99)",
                  fontSize: "16px",
                  paddingTop: "10px",
                  paddingBottom: "10px",
                  paddingLeft:"35px",
                  paddingRight: "35px"
                }}
              >
                  <span>{t('create.buttonCreateSecret')}</span>
              </Button>
            </Box>
            <Box p={2} pb={4}>
              <Button
                onClick={() => handleSubmit(onSubmit)()}
                variant="contained"
                disabled={loading}
                sx={{ 
                  borderRadius: "20px",
                  backgroundImage: "linear-gradient(45deg,#0096bb,#6cbe99)",
                  fontSize: "16px",
                  paddingTop: "10px",
                  paddingBottom: "10px",
                  paddingLeft:"35px",
                  paddingRight: "35px"
                }}
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

export const OneTime = (props: { control: Control<any> }) => {
  const { t } = useTranslation();

  return (
    <Grid item justifyContent="center">
      <FormControlLabel
        control={
          <Controller
            name="onetime"
            control={props.control}
            render={({ field }) => (
              <Checkbox
                {...field}
                id="enable-onetime"
                defaultChecked={true}
                color="primary"
              />
            )}
          />
        }
        label={t('create.inputOneTimeLabel') as string}
      />
    </Grid>
  );
};

export const SpecifyPasswordInput = (props: { control: Control<any> }) => {
  const { t } = useTranslation();
  return (
    <Grid item justifyContent="center">
      <InputLabel>{t('create.inputPasswordLabel')}</InputLabel>
      <Controller
        name="password"
        control={props.control}
        render={({ field }) => (
          <TextField
            {...field}
            fullWidth
            type="text"
            id="password"
            variant="outlined"
            inputProps={{
              autoComplete: 'off',
              spellCheck: 'false',
              'data-gramm': 'false',
            }}
          />
        )}
      />
    </Grid>
  );
};

export const SpecifyPasswordToggle = (props: { control: Control<any> }) => {
  const { t } = useTranslation();
  return (
    <FormGroup>
      <FormControlLabel
        control={
          <Controller
            name="generateDecryptionKey"
            control={props.control}
            render={({ field }) => (
              <Checkbox {...field} defaultChecked={true} color="primary" />
            )}
          />
        }
        label={t('create.inputGenerateLabel') as string}
      />
    </FormGroup>
  );
};

export default CreateSecret;
