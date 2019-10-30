import { decode } from 'base64-arraybuffer';
import { saveAs } from 'file-saver';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as sjcl from 'sjcl';
import Error from './Error';
import Form from './Form';

const Download = () => {
  const [loading, setLoading] = useState(false);
  const [error, showError] = useState(false);
  const { key, password } = useParams();

  const decrypt = async (pass: string) => {
    setLoading(true);
    const url = process.env.REACT_APP_BACKEND_URL
      ? `${process.env.REACT_APP_BACKEND_URL}/file`
      : '/file';
    try {
      const request = await fetch(`${url}/${key}`);
      if (request.status === 200) {
        const data = await request.json();
        const blob = sjcl.decrypt(pass, data.file);
        const fileName = sjcl.decrypt(pass, data.file_name);
        console.log(fileName);
        setLoading(false);
        saveAs(
          new Blob([decode(blob)], { type: 'application/octet-stream' }),
          fileName,
        );
        return;
      }
    } catch (e) {
      console.log(e);
    }
    setLoading(false);
    showError(true);
  };

  useEffect(() => {
    if (password) {
      decrypt(password);
    }
  }, [password]);

  return (
    <div>
      {loading && (
        <h3>
          Fetching from database and decrypting in browser, please hold...
        </h3>
      )}
      <Error display={error} />
      <Form display={!password} uuid={key} prefix="f" />
    </div>
  );
};

export default Download;
