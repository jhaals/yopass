import { faFileUpload } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { encrypt, message } from 'openpgp';
import { useCallback } from 'react';
import { useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Error,
  OneTime,
  SpecifyPasswordToggle,
  SpecifyPasswordInput,
} from './CreateSecret';
import Lifetime from './Lifetime';
import Result from '../displaySecret/Result';
import { randomString, uploadFile } from '../utils/utils';
import { useTranslation } from 'react-i18next';
import { Row } from 'reactstrap';
import { useForm } from 'react-hook-form';

const Upload = () => {
  const maxSize = 1024 * 500;
  const [error, setError] = useState('');
  const { t } = useTranslation();
  const [result, setResult] = useState({
    password: '',
    prefix: '',
    uuid: '',
  });

  const { register, handleSubmit, watch } = useForm({
    defaultValues: {
      generateDecryptionKey: true,
      secret: '',
      password: '',
      lifetime: '3600',
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
        const file = await encrypt({
          armor: true,
          message: message.fromBinary(
            new Uint8Array(reader.result as ArrayBuffer),
            acceptedFiles[0].name,
          ),
          passwords: pw,
        });
        const { data, status } = await uploadFile({
          expiration: parseInt(form.lifetime),
          message: file.data,
          one_time: form.onetime,
        });

        if (status !== 200) {
          setError(data.message);
        } else {
          setResult({
            uuid: data.message,
            password: pw,
            prefix: form.password ? 'd' : 'f',
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

  const onSubmit = async (form: any): Promise<void> => {};

  const isFileTooLarge =
    fileRejections.length > 0 &&
    fileRejections[0].errors[0].code === 'file-too-large';

  const generateDecryptionKey = watch('generateDecryptionKey');

  return (
    <div className="text-center">
      {isFileTooLarge && <Error message={t('File is too large')} />}
      <Error message={error} onClick={() => setError('')} />
      {result.uuid ? (
        <Result
          uuid={result.uuid}
          password={result.password}
          prefix={result.prefix}
        />
      ) : (
        <div>
          <form onSubmit={handleSubmit(onSubmit)}>
            <div {...getRootProps()}>
              <input {...getInputProps()} />
              <div className="text-center mt-5">
                <h4>{t('Drop file to upload')}</h4>
                <p className="text-muted">
                  {t(
                    'File upload is designed for small files like ssh keys and certificates.',
                  )}
                </p>
                <FontAwesomeIcon
                  color={isDragActive ? 'blue' : 'black'}
                  size="8x"
                  icon={faFileUpload}
                />
              </div>
            </div>
            <Lifetime register={register} />
            <Row>
              <OneTime register={register} />
              <SpecifyPasswordToggle register={register} />
            </Row>
            {!generateDecryptionKey && (
              <SpecifyPasswordInput register={register} />
            )}
          </form>
        </div>
      )}
    </div>
  );
};

export default Upload;
