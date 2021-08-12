import { faFileUpload } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { encrypt, message } from 'openpgp';
import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Error,
} from './CreateSecret';
import Expiration from './../shared/Expiration';
import Result from '../displaySecret/Result';
import { randomString, uploadFile } from '../utils/utils';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { Grid, Typography } from '@material-ui/core';
import { useAuth } from 'oidc-react';

const Upload = () => {
  const maxSize = 1024 * 500;
  const [error, setError] = useState('');
  const { t } = useTranslation();
  const [result, setResult] = useState({
    password: '',
    uuid: '',
  });

  const { control, handleSubmit, watch } = useForm({
    defaultValues: {
      generateDecryptionKey: true,
      secret: '',
      password: '',
      expiration: '3600',
    },
  });

  const form = watch();
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const reader = new FileReader();
      reader.onabort = () => console.log('file reading was aborted');
      reader.onerror = () => console.log('file reading has failed');
      reader.onload = async () => {
        handleSubmit(onSubmit)();
        const pw = form.password ? form.password : randomString();
        const file = await encrypt({
          armor: true,
          message: message.fromBinary(
            new Uint8Array(reader.result as ArrayBuffer),
            acceptedFiles[0].name,
          ),
          passwords: pw,
        });
        const { data, status } = await uploadFile({
          expiration: parseInt(form.expiration),
          message: file.data,
          one_time: true,
        });

        if (status !== 200) {
          setError(data.message);
        } else {
          setResult({
            uuid: data.message,
            password: pw,
          });
        }
      };
      acceptedFiles.forEach((file) => reader.readAsArrayBuffer(file));
    },
    [form, handleSubmit],
  );

  const {
    getRootProps,
    getInputProps,
    fileRejections,
    isDragActive,
  } = useDropzone({
    maxSize,
    minSize: 0,
    onDrop,
  });

  const onSubmit = () => { };

  const isFileTooLarge =
    fileRejections.length > 0 &&
    fileRejections[0].errors[0].code === 'file-too-large';

  const auth = useAuth();

  var WebFont = require('webfontloader');

  WebFont.load({
    google: {
      families: [
        'Red Hat Display',
        'Red Hat Text',
      ]
    }
  });

  if (result.uuid) {
    return (
      <Result
        uuid={result.uuid}
        password={result.password}
        prefix="f"
      />
    );
  }

  return (
    <Grid>
      {isFileTooLarge &&
        <Error message={t('File is too large.')} />
      }
      <Error message={error} onClick={() => setError('')} />
      <form onSubmit={handleSubmit(onSubmit)}>
        <div {...getRootProps()}>
          <input {...getInputProps()} />
          <Grid container justifyContent="center">
            <Typography variant="h4"
              style={{ fontFamily: "Red Hat Display, sans-serif", textAlign: "center" }}
            >{t('Upload File')}</Typography>
          </Grid>
          <Typography
            align="center"
            style={{ fontFamily: "Red Hat Display, sans-serif", padding: '.5em' }}
          >
            {auth.userData?.profile.email}
          </Typography>
          <span style={{ padding: '3em' }} />
          <Grid container justifyContent="center">
            <Typography variant="caption" display="block"
              style={{ fontFamily: "Red Hat Display, sans-serif" }}
            >
              {t('File upload is limited for small files (<=7 kB), such as ssh keys and certificates.')}
            </Typography>
          </Grid>
          <span style={{ padding: '3em' }} />
          <Grid container justifyContent="center">
            <FontAwesomeIcon
              color={isDragActive ? 'blue' : 'black'}
              size="8x"
              icon={faFileUpload}
            />
          </Grid>
        </div>

        <Grid container justifyContent="center" mt="15px">
          <Expiration control={control} />
        </Grid>
      </form>
    </Grid>
  );
};

export default Upload;
