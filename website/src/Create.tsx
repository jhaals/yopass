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
import { BACKEND_DOMAIN, randomString } from './utils';

const Create = () => {
  const [expiration, setExpiration] = useState('3600');
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [uuid, setUUID] = useState('');
  const [password, setPassword] = useState('');

  const submit = async () => {
    if (secret === '') {
      return;
    }
    setLoading(true);
    setError('');
    try {
      const pw = randomString();
      const request = await fetch(BACKEND_DOMAIN + '/secret', {
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
        <Result uuid={uuid} password={password} prefix="s" />
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

export const Error = (
  props: { readonly message: string } & React.HTMLAttributes<HTMLElement>,
) =>
  props.message ? (
    <Alert color="danger" {...props}>
      {props.message}
    </Alert>
  ) : null;

export default Create;
