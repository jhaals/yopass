import { useTranslation } from 'react-i18next';
import { useForm, UseFormMethods } from 'react-hook-form';
import randomString, { encryptMessage, postSecret } from '../utils/utils';
import { useState } from 'react';
import Result from '../displaySecret/Result';
import Expiration from './../shared/Expiration';
import {
  Alert,
  Checkbox,
  FormGroup,
  FormControlLabel,
  TextField,
  Typography,
  Input,
  Button,
  Paper,
  Grid,
} from '@material-ui/core';

const CreateSecret = () => {
  const { t } = useTranslation();
  const {
    control,
    register,
    errors,
    handleSubmit,
    watch,
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
    prefix: '',
    uuid: '',
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.ctrlKey && event.key === 'Enter') {
      handleSubmit(onSubmit)();
    }
  };

  const onSubmit = async (form: any): Promise<void> => {
    // Use the manually entered password, or generate one
    const pw = form.password ? form.password : randomString();
    setLoading(true);
    try {
      const { data, status } = await postSecret({
        expiration: parseInt(form.expiration),
        message: await encryptMessage(form.secret, pw),
        one_time: form.onetime,
      });

      if (status !== 200) {
        setError('secret', { type: 'submit', message: data.message });
      } else {
        setResult({
          prefix: form.password ? 'c' : 's',
          password: pw,
          uuid: data.message,
        });
      }
    } catch (e) {
      setError('secret', { type: 'submit', message: e.message });
    }
    setLoading(false);
  };

  const generateDecryptionKey = watch('generateDecryptionKey');

  return (
    <Paper>
      <Typography component="h1" variant="h3" align="center">
        {t('Encrypt message')}
      </Typography>
      <Error
        message={errors.secret?.message}
        onClick={() => clearErrors('secret')}
      />
      {result.uuid ? (
        <Result
          password={result.password}
          uuid={result.uuid}
          prefix={result.prefix}
        />
      ) : (
        <form onSubmit={handleSubmit(onSubmit)}>
          <Grid container justifyContent="center">
            <TextField
              inputRef={register({ required: true })}
              multiline={true}
              name="secret"
              fullWidth
              label={t('Secret message')}
              rows="4"
              autoFocus={true}
              onKeyDown={onKeyDown}
              placeholder={t('Message to encrypt locally in your browser')}
            />
            <Grid container justifyContent="center">
              <Expiration control={control} />
            </Grid>
            <Grid container justifyContent="center">
              <OneTime register={register} />
              <SpecifyPasswordToggle register={register} />
              {!generateDecryptionKey && (
                <SpecifyPasswordInput register={register} />
              )}
            </Grid>
            <Button variant="contained" disabled={loading}>
              {loading ? (
                <span>{t('Encrypting message...')}</span>
              ) : (
                <span>{t('Encrypt Message')}</span>
              )}
            </Button>
          </Grid>
        </form>
      )}
    </Paper>
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
      label={t('One-time download')}
    />
  );
};

export const SpecifyPasswordInput = (props: {
  register: UseFormMethods['register'];
}) => {
  const { t } = useTranslation();
  return (
    <FormGroup>
      <Input
        type="text"
        id="password"
        inputRef={props.register()}
        name="password"
        placeholder={t('Manually enter decryption key')}
        autoComplete="off"
      />
    </FormGroup>
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
        label={t('Generate decryption key')}
      />
    </FormGroup>
  );
};

export default CreateSecret;
