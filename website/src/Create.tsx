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
          <Lifetime expiration={expiration} setExpiration={setExpiration} />
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

const Lifetime = (
  props: {
    readonly expiration: string;
    readonly setExpiration: React.Dispatch<React.SetStateAction<string>>;
  } & React.HTMLAttributes<HTMLElement>,
) => {
  const { expiration, setExpiration } = props;
  const buttons = [];
  for (const i of [
    {
      duration: '3600',
      name: '1h',
      text: 'One Hour',
    },
    {
      duration: '86400',
      name: '1d',
      text: 'One Day',
    },
    {
      duration: '604800',
      name: '1w',
      text: 'One Week',
    },
  ]) {
    buttons.push(
      <FormGroup check={true}>
        <Label check={true}>
          <Input
            type="radio"
            name={i.name}
            value={i.duration}
            onChange={e => setExpiration(e.target.value)}
            checked={expiration === i.duration}
          />
          {i.text}
        </Label>
      </FormGroup>,
    );
  }

  return (
    <FormGroup tag="fieldset">
      <Label>Lifetime</Label>
      <FormText color="muted">
        The encrypted message will be deleted automatically after
      </FormText>
      {buttons}
    </FormGroup>
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
