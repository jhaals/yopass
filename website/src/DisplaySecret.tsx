import * as React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Error from './Error';
import Form from './Form';
import { decryptMessage } from './utils';

const DisplaySecret = () => {
  const [loading, setLoading] = useState(false);
  const [error, showError] = useState(false);
  const [secret, setSecret] = useState('');
  const { key, password } = useParams();
  const decrypt = useCallback(async () => {
    if (!password) {
      return;
    }
    setLoading(true);
    const url = process.env.REACT_APP_BACKEND_URL
      ? `${process.env.REACT_APP_BACKEND_URL}/secret`
      : '/secret';
    try {
      const request = await fetch(`${url}/${key}`);
      if (request.status === 200) {
        const data = await request.json();
        const r = await decryptMessage(data.message, password, 'utf8');
        setSecret(r.data as string);
        setLoading(false);
        return;
      }
    } catch (e) {
      console.log(e);
    }
    setLoading(false);
    showError(true);
  }, [password, key]);

  useEffect(() => {
    decrypt();
  }, [decrypt]);

  return (
    <div>
      {loading && (
        <h3>
          Fetching from database and decrypting in browser, please hold...
        </h3>
      )}
      <Error display={error} />
      <Secret secret={secret} />
      <Form display={!password} uuid={key} prefix="s" />
    </div>
  );
};

const Secret = (
  props: { readonly secret: string } & React.HTMLAttributes<HTMLElement>,
) =>
  props.secret ? (
    <div>
      <h1>Decrypted Message</h1>
      This secret might not be viewable again, make sure to save it now!
      <pre>{props.secret}</pre>
    </div>
  ) : null;

export default DisplaySecret;
