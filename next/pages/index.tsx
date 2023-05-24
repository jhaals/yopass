import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { useTranslation } from 'react-i18next';
import { useForm, UseFormMethods } from 'react-hook-form';
import randomString, {
  encryptMessage,
  isErrorWithMessage,
  postSecret,
} from '../src/utils';
import React, { useState } from 'react';
import { Error } from '../src/components/Error';
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
import Result from '../src/components/Result';
import Expiration from '../src/components/Expiration';

export async function getStaticProps({ locale }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  };
}

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
    uuid: '',
    customPassword: false,
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
            inputProps={{ spellCheck: 'false', 'data-gramm': 'false' }}
          />
          <Grid container justifyContent="center" marginTop={2}>
            <Expiration control={control} />
          </Grid>
          <Grid container alignItems="center" direction="column">
            <OneTime register={register} />
            <SpecifyPasswordToggle register={register} />
            {!generateDecryptionKey && (
              <SpecifyPasswordInput register={register} />
            )}
          </Grid>
          <Grid container justifyContent="center">
            <Box p={2} pb={4}>
              <Button
                onClick={() => handleSubmit(onSubmit)()}
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
        label={t('create.inputOneTimeLabel') as string}
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
        label={t('create.inputGenerateLabel') as string}
      />
    </FormGroup>
  );
};

export default CreateSecret;
