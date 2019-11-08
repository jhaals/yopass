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
import Result from './Result';
import { encryptMessage, postSecret, randomString } from './utils';

const Create = () => {
  const [expiration, setExpiration] = useState(3600);
  const [error, setError] = useState();
  const [secret, setSecret] = useState();
  const [loading, setLoading] = useState(false);
  const [uuid, setUUID] = useState();
  const [password, setPassword] = useState('');

  const submit = async () => {
    if (!secret) {
      return;
    }
    setLoading(true);
    setError('');
    try {
      const pw = randomString();
      const { data, status } = await postSecret({
        expiration,
        secret: await encryptMessage(secret, pw),
      });
      if (status !== 200) {
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
    <div className="text-center">
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

export const Lifetime = (
  props: {
    readonly expiration: number;
    readonly setExpiration: React.Dispatch<React.SetStateAction<number>>;
  } & React.HTMLAttributes<HTMLElement>,
) => {
  const { expiration, setExpiration } = props;
  const buttons = [];
  for (const i of [
    {
      duration: 3600,
      name: '1h',
      text: 'One Hour',
    },
    {
      duration: 86400,
      name: '1d',
      text: 'One Day',
    },
    {
      duration: 604800,
      name: '1w',
      text: 'One Week',
    },
  ]) {
    buttons.push(
      <FormGroup key={i.name} check={true} inline={true}>
        <Label check={true}>
          <Input
            type="radio"
            name={i.name}
            value={i.duration}
            onChange={e => setExpiration(+e.target.value)}
            checked={expiration === i.duration}
          />
          {i.text}
        </Label>
      </FormGroup>,
    );
  }

  return (
    <FormGroup tag="fieldset">
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
