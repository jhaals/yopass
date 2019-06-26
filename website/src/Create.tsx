import * as React from 'react';
import { useState } from 'react';
import {
  Alert,
  Button,
  Form,
  FormGroup,
  FormText,
  Input,
  Label,
} from 'reactstrap';
import * as sjcl from 'sjcl';
import Result from './Result';

const Create = () => {
  const [expiration, setExpiration] = useState('3600');
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [uuid, setUUID] = useState('');
  const [password, setPassword] = useState('');
  const BACKEND_DOMAIN = process.env.REACT_APP_BACKEND_URL
    ? `${process.env.REACT_APP_BACKEND_URL}/secret`
    : '/secret';

  const submit = async () => {
    if (secret === '') {
      return;
    }
    setLoading(true);
    setError('');
    try {
      const pw = randomString();
      const request = await fetch(BACKEND_DOMAIN, {
        body: JSON.stringify({
          expiration: parseInt(expiration, 10),
          secret: sjcl.encrypt(pw, secret).toString(),
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
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div>
      <h1>Encrypt message</h1>
      <Error message={error} onClick={() => setError('')} />
      {uuid ? (
        <Result uuid={uuid} password={password} />
      ) : (
        <Form>
          <FormGroup>
            <Label>Secret message</Label>
            <Input
              type="textarea"
              name="secret"
              rows="4"
              autoFocus={true}
              placeholder="Message to encrypt locally in your browser"
              onChange={e => setSecret(e.target.value)}
              value={secret}
            />
          </FormGroup>
          <FormGroup tag="fieldset">
            <Label>Lifetime</Label>
            <FormText color="muted">
              The encrypted message will be deleted automatically after
            </FormText>
            <FormGroup check={true}>
              <Label check={true}>
                <Input
                  type="radio"
                  name="1h"
                  value="3600"
                  onChange={e => setExpiration(e.target.value)}
                  checked={expiration === '3600'}
                />
                One Hour
              </Label>
            </FormGroup>
            <FormGroup check={true}>
              <Label check={true}>
                <Input
                  type="radio"
                  name="1d"
                  value="86400"
                  onChange={e => setExpiration(e.target.value)}
                  checked={expiration === '86400'}
                />
                One Day
              </Label>
            </FormGroup>
            <FormGroup check={true} disabled={true}>
              <Label check={true}>
                <Input
                  type="radio"
                  name="1w"
                  value="604800"
                  onChange={e => setExpiration(e.target.value)}
                  checked={expiration === '604800'}
                />
                One Week
              </Label>
            </FormGroup>
          </FormGroup>
          <Button
            disabled={loading}
            color="primary"
            size="lg"
            block={true}
            onClick={() => submit()}
          >
            {loading ? (
              <span>Encrypting message...</span>
            ) : (
              <span>Encrypt Message</span>
            )}
          </Button>
        </Form>
      )}
    </div>
  );
};

const Error = (
  props: { readonly message: string } & React.HTMLAttributes<HTMLElement>,
) =>
  props.message ? (
    <Alert color="danger" {...props}>
      {props.message}
    </Alert>
  ) : null;

const randomString = (): string => {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 22; i++) {
    text += possible.charAt(randomInt(0, possible.length));
  }
  return text;
};

const randomInt = (min: number, max: number): number => {
  const byteArray = new Uint8Array(1);
  window.crypto.getRandomValues(byteArray);

  const range = max - min;
  const maxRange = 256;
  if (byteArray[0] >= Math.floor(maxRange / range) * range) {
    return randomInt(min, max);
  }
  return min + (byteArray[0] % range);
};

export default Create;
