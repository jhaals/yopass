import { faFileUpload } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { encrypt, createMessage } from 'openpgp';
import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { OneTime, SpecifyPasswordToggle, SpecifyPasswordInput } from './index';
import Error from '../src/components/Error';
import Expiration from '../src/components/Expiration';
import Result from '../src/components/Result';
import { randomString, uploadFile } from '../src/utils';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { Grid, Typography } from '@mui/material';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { MAX_FILE_LENGTH } from '../src/api/consts';

export async function getStaticProps({ locale }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  };
}

const Upload = () => {
  const [error, setError] = useState('');
  const { t } = useTranslation();
  const [result, setResult] = useState({
    password: '',
    customPassword: false,
    uuid: '',
  });

  const { control, register, handleSubmit, watch } = useForm({
    defaultValues: {
      generateDecryptionKey: true,
      secret: '',
      password: '',
      expiration: '3600',
      onetime: true,
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
        const message = await encrypt({
          format: 'armored',
          message: await createMessage({
            binary: new Uint8Array(reader.result as ArrayBuffer),
            filename: acceptedFiles[0].name,
          }),
          passwords: pw,
        });
        const { data, status } = await uploadFile({
          expiration: parseInt(form.expiration),
          message,
          one_time: form.onetime,
        });

        if (status !== 200) {
          setError(data.message);
        } else {
          setResult({
            uuid: data.message,
            password: pw,
            customPassword: form.password ? true : false,
          });
        }
      };
      acceptedFiles.forEach((file) => reader.readAsArrayBuffer(file));
    },
    [form, handleSubmit],
  );

  const { getRootProps, getInputProps, fileRejections, isDragActive } =
    useDropzone({
      maxSize: MAX_FILE_LENGTH,
      minSize: 0,
      onDrop,
    });

  const onSubmit = () => {};

  const isFileTooLarge =
    fileRejections.length > 0 &&
    fileRejections[0].errors[0].code === 'file-too-large';

  const generateDecryptionKey = watch('generateDecryptionKey');

  if (result.uuid) {
    return (
      <Result
        uuid={result.uuid}
        password={result.password}
        prefix="f"
        customPassword={result.customPassword}
      />
    );
  }
  return (
    <Grid>
      {isFileTooLarge && <Error message={t('upload.fileTooLarge')} />}
      <Error message={error} onClick={() => setError('')} />
      <form onSubmit={handleSubmit(onSubmit)}>
        <div {...getRootProps()}>
          <input {...getInputProps()} />
          <Grid container justifyContent="center">
            <Typography variant="h4">{t('upload.title')}</Typography>
          </Grid>
          <Grid container justifyContent="center">
            <Typography variant="caption" display="block">
              {t('upload.caption')}
            </Typography>
          </Grid>
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
        <Grid container alignItems="center" direction="column">
          <OneTime register={register} />
          <SpecifyPasswordToggle register={register} />
          <Grid container justifyContent="center">
            {!generateDecryptionKey && (
              <SpecifyPasswordInput register={register} />
            )}
          </Grid>
        </Grid>
      </form>
    </Grid>
  );
};

export default Upload;
