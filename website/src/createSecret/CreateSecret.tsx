import { useTranslation } from 'react-i18next';
import { Form, FormGroup } from 'reactstrap';
import { useForm, UseFormMethods } from 'react-hook-form';
import randomString, { encryptMessage, postSecret } from '../utils/utils';
import { useState } from 'react';
import Result from '../displaySecret/Result';
import Lifetime from './Lifetime';
import {
  Alert,
  Checkbox,
  FormControlLabel,
  TextField,
  Input,
  Button,
} from '@material-ui/core';

const CreateSecret = () => {
  const { t } = useTranslation();
  const {
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
    console.log(form);
    // Use the manually entered password, or generate one
    const pw = form.password ? form.password : randomString();
    setLoading(true);
    try {
      const { data, status } = await postSecret({
        expiration: parseInt(form.lifetime),
        message: await encryptMessage(form.secret, pw),
        one_time: true,
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
    <div className="text-center">
      <h1>{t('Encrypt message')}</h1>
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
        <Form onSubmit={handleSubmit(onSubmit)}>
          <FormGroup>
            <TextField
              inputRef={register({ required: true })}
              multiline={true}
              name="secret"
              label={t('Secret message')}
              rows="4"
              autoFocus={true}
              onKeyDown={onKeyDown}
              placeholder={t('Message to encrypt locally in your browser')}
            />
          </FormGroup>
          <Lifetime register={register} />
          <div className="row">
            <OneTime register={register} />
            <SpecifyPasswordToggle register={register} />
          </div>
          {!generateDecryptionKey && (
            <SpecifyPasswordInput register={register} />
          )}
          <Button variant="contained" disabled={loading}>
            {loading ? (
              <span>{t('Encrypting message...')}</span>
            ) : (
              <span>{t('Encrypt Message')}</span>
            )}
          </Button>
        </Form>
      )}
    </div>
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
    <FormGroup className="offset-md-3 col-md-3">
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
    </FormGroup>
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
    <FormGroup className="col-md-3">
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
