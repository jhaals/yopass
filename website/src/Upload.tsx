import { faFileUpload } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { encode } from 'base64-arraybuffer';
import * as React from 'react';
import { useState } from 'react';
import { useDropzone } from 'react-dropzone';
import * as sjcl from 'sjcl';
import './App.css';
import { Error } from './Create';
import Result from './Result';
import { BACKEND_DOMAIN, randomString } from './utils';

const Upload = () => {
  const maxSize = 1024 * 500;
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [uuid, setUUID] = useState('');

  const onDrop = React.useCallback((acceptedFiles: File[]) => {
    const reader = new FileReader();
    reader.onabort = () => console.log('file reading was aborted');
    reader.onerror = () => console.log('file reading has failed');
    reader.onload = async () => {
      console.log(acceptedFiles[0].size);
      const pw = randomString();
      const fileBlob = sjcl.encrypt(pw, encode(reader.result as ArrayBuffer));
      const fileName = sjcl.encrypt(pw, acceptedFiles[0].name);

      const request = await fetch(BACKEND_DOMAIN + '/file', {
        body: JSON.stringify({
          expiration: 3600,
          file: fileBlob,
          file_name: fileName,
        }),
        method: 'POST',
      });
      const data = await request.json();
      if (request.status !== 200) {
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
    <div>
      {isFileTooLarge && <Error message="File is too large" />}
      <Error message={error} onClick={() => setError('')} />
      {uuid ? (
        <Result uuid={uuid} password={password} prefix="f" />
      ) : (
        <div {...getRootProps()}>
          <input {...getInputProps()} />
          <div className="text-center mt-5">
            <h4>Drop file to upload</h4>
            <FontAwesomeIcon
              color={isDragActive ? 'blue' : 'black'}
              size="6x"
              icon={faFileUpload}
            />{' '}
          </div>
        </div>
      )}
    </div>
  );
};

export default Upload;
