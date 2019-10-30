import * as React from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as sjcl from 'sjcl';
import Error from './Error';
import Form from './Form';

const displaySecret = (props: any & React.HTMLAttributes<HTMLElement>) => {
  const [loading, setLoading] = useState(false);
  const [error, showError] = useState(false);
  const [secret, setSecret] = useState('');
  const { key, password } = useParams();

  const decrypt = async (pass: string) => {
    setLoading(true);
    const url = process.env.REACT_APP_BACKEND_URL
      ? `${process.env.REACT_APP_BACKEND_URL}/secret`
      : '/secret';
    try {
      const request = await fetch(`${url}/${key}`);
      if (request.status === 200) {
        const data = await request.json();
        setSecret(sjcl.decrypt(pass, data.message));
        setLoading(false);
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
      This secret will not be viewable again, make sure to save it now!
      <pre>{props.secret}</pre>
    </div>
  ) : null;

export default displaySecret;
