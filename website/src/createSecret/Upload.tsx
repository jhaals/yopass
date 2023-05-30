import { faFileUpload } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { encrypt, createMessage } from 'openpgp';
import { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Error } from './CreateSecret';
import Expiration from './../shared/Expiration';
import Result from '../displaySecret/Result';
import { randomString, uploadFile } from '../utils/utils';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { Grid, Typography } from '@mui/material';
import { useAuth } from 'oidc-react';

const Upload = () => {
  const maxSize = 1024 * 1024 * 50; // 50 MB
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
      console.log('User logged out!');
      return signIn();
    } else {
      console.log('User logged in....');
    }

    if (auth?.userData?.expired === true) {
      console.log('Access token expired!');
      auth.userManager.signinSilent().then(console.log).catch(console.error);
    } else {
      console.log('Access token not expired....');
    }
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
          one_time: true,
          access_token: auth?.userData?.access_token,
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
    [
      auth?.userData?.access_token,
      form.expiration,
      form.password,
      handleSubmit,
    ],
  );

  const { getRootProps, getInputProps, fileRejections, isDragActive } =
    useDropzone({
      maxSize,
      minSize: 0,
      onDrop,
    });

  const onSubmit = () => {};

  const isFileTooLarge =
    fileRejections.length > 0 &&
    fileRejections[0].errors[0].code === 'file-too-large';

  var WebFont = require('webfontloader');

  WebFont.load({
    google: {
      families: ['Red Hat Display', 'Red Hat Text'],
    },
  });

  if (result.uuid) {
    return <Result uuid={result.uuid} password={result.password} prefix="f" />;
  }
  return (
    <Grid>
      {isFileTooLarge && <Error message={t<string>('upload.fileTooLarge')} />}
      <Error message={error} onClick={() => setError('')} />

      <form onSubmit={handleSubmit(onSubmit)}>
        <div {...getRootProps()}>
          <input date-test-id="inputUpload" {...getInputProps()} />

          <Grid container justifyContent="center">
            <Typography variant="h4">{t('upload.title')}</Typography>
          </Grid>

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

          <Grid container justifyContent="center">
            <Typography variant="caption" display="block">
              {t('upload.caption')}
            </Typography>
          </Grid>
          <span style={{ padding: '.5em' }} />
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
