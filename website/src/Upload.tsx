import { faFileUpload } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import * as openpgp from 'openpgp';
import * as React from 'react';
import { useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Error, Lifetime, OneTime } from './Create';
import Result from './Result';
import { randomString, uploadFile } from './utils';
import { useTranslation } from 'react-i18next';

const Upload = () => {
  const maxSize = 1024 * 500;
  const [password, setPassword] = useState('');
  const [onetime, setOnetime] = useState(true);
  const [expiration, setExpiration] = useState(3600);
  const [error, setError] = useState('');
  const [uuid, setUUID] = useState('');
  const { t } = useTranslation();

  const onDrop = React.useCallback(
    (acceptedFiles: File[]) => {
      const reader = new FileReader();
      reader.onabort = () => console.log('file reading was aborted');
      reader.onerror = () => console.log('file reading has failed');
      reader.onload = async () => {
        const pw = randomString();
        const file = await openpgp.encrypt({
          armor: true,
          message: openpgp.message.fromBinary(
            new Uint8Array(reader.result as ArrayBuffer),
            acceptedFiles[0].name,
          ),
          passwords: pw,
        });
        const { data, status } = await uploadFile({
          expiration,
          message: file.data,
          one_time: onetime,
        });

        if (status !== 200) {
          setError(data.message);
        } else {
          setUUID(data.message);
          setPassword(pw);
        }
      };
      acceptedFiles.forEach((file) => reader.readAsArrayBuffer(file));
    },
    [expiration, onetime],
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

  const isFileTooLarge =
    fileRejections.length > 0 &&
    fileRejections[0].errors[0].code === 'file-too-large';

  return (
    <div className="text-center">
      {isFileTooLarge && <Error message={t('File is too large')} />}
      <Error message={error} onClick={() => setError('')} />
      {uuid ? (
        <Result uuid={uuid} password={password} prefix="f" />
      ) : (
        <div>
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
              />{' '}
            </div>
          </div>
          <div className="upload-lifetime">
            <OneTime setOnetime={setOnetime} onetime={onetime} />
            <Lifetime expiration={expiration} setExpiration={setExpiration} />
          </div>
        </div>
      )}
    </div>
  );
};

export default Upload;
