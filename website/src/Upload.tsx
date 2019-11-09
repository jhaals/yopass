import { faFileUpload } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import * as openpgp from 'openpgp';
import * as React from 'react';
import { useState } from 'react';
import { useDropzone } from 'react-dropzone';
import './App.css';
import { Error, Lifetime } from './Create';
import Result from './Result';
import { randomString, uploadFile } from './utils';

const Upload = () => {
  const maxSize = 1024 * 500;
  const [password, setPassword] = useState('');
  const [expiration, setExpiration] = useState(3600);
  const [error, setError] = useState('');
  const [uuid, setUUID] = useState('');

  const onDrop = React.useCallback((acceptedFiles: File[]) => {
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
        secret: file.data,
      });

      if (status !== 200) {
        setError(data.message);
      } else {
        setUUID(data.message);
        setPassword(pw);
      }
    };
    acceptedFiles.forEach(file => reader.readAsArrayBuffer(file));
  }, []);

  const {
    getRootProps,
    getInputProps,
    rejectedFiles,
    isDragActive,
  } = useDropzone({
    maxSize,
    minSize: 0,
    onDrop,
  });

  const isFileTooLarge =
    rejectedFiles.length > 0 && rejectedFiles[0].size > maxSize;

  return (
    <div className="text-center">
      {isFileTooLarge && <Error message="File is too large" />}
      <Error message={error} onClick={() => setError('')} />
      {uuid ? (
        <Result uuid={uuid} password={password} prefix="f" />
      ) : (
        <div>
          <div {...getRootProps()}>
            <input {...getInputProps()} />
            <div className="text-center mt-5">
              <h4>Drop file to upload</h4>
              <p className="text-muted">
                File upload is limited to small files; Think ssh keys and
                similar.
              </p>
              <FontAwesomeIcon
                color={isDragActive ? 'blue' : 'black'}
                size="8x"
                icon={faFileUpload}
              />{' '}
            </div>
          </div>
          <div className="upload-lifetime">
            <Lifetime expiration={expiration} setExpiration={setExpiration} />
          </div>
        </div>
      )}
    </div>
  );
};

export default Upload;
