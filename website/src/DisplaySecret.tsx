import * as React from 'react';
import { useEffect, useState } from 'react';
import { Redirect } from 'react-router-dom';
import { Button, Col, FormGroup, Input, Label } from 'reactstrap';
import * as sjcl from 'sjcl';

const displaySecret = (props: any & React.HTMLAttributes<HTMLElement>) => {
  const [loading, setLoading] = useState(false);
  const [error, showError] = useState(false);
  const [secret, setSecret] = useState('');

  const decrypt = async () => {
    setLoading(true);
    const url = process.env.REACT_APP_BACKEND_URL
      ? `${process.env.REACT_APP_BACKEND_URL}/secret`
      : '/secret';
    try {
      const request = await fetch(`${url}/${props.match.params.key}`);
      if (request.status === 200) {
        const data = await request.json();
        setSecret(sjcl.decrypt(props.match.params.password, data.message));
        setLoading(false);
        return;
      }
    } catch (e) {
      console.log(e);
    }
    setLoading(false);
    showError(true);
  };

  useEffect(
    () => {
      if (props.match.params.password) {
        decrypt();
      }
    },
    [props.match.params.password],
  );

  return (
    <div>
      {loading && (
        <h3>
          Fetching from database and decrypting in browser, please hold...
        </h3>
      )}
      <Error display={error} />
      <Secret secret={secret} />
      <Form
        display={!props.match.params.password}
        uuid={props.match.params.key}
      />
    </div>
  );
};

const Form = (
  props: {
    readonly display: boolean;
    readonly uuid: string;
  } & React.HTMLAttributes<HTMLElement>,
) => {
  const [password, setPassword] = useState('');
  const [redirect, setRedirect] = useState(false);

  if (redirect) {
    return <Redirect to={`/s/${props.uuid}/${password}`} />;
  }
  return props.display ? (
    <Col sm="6">
      <FormGroup>
        <Label>A decryption key is required, please enter it below</Label>
        <Input
          type="text"
          autoFocus={true}
          placeholder="Decryption Key"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
      </FormGroup>
      <Button block={true} size="lg" onClick={() => setRedirect(true)}>
        Decrypt Secret
      </Button>
    </Col>
  ) : null;
};

const Error = (
  props: { readonly display: boolean } & React.HTMLAttributes<HTMLElement>,
) =>
  props.display ? (
    <div>
      <h2>Secret does not exist</h2>
      <p className="lead">
        It might be caused by <b>any</b> of these reasons.
      </p>
      <h4>Opened before</h4>A secret can only be displayed ONCE. It might be
      lost because the sender clicked this link before you viewed it.
      <p>
        The secret might have been compromised and read by someone else. You
        should contact the sender and request a new secret
      </p>
      <h4>Broken link</h4>
      <p>
        The link you have been must match perfectly in order for the decryption
        to work, it might be missing some magic digits.
      </p>
      <h4>Expired</h4>
      <p>
        No secrets last forever. All stored secrets will expires and self
        destruct automatically. Lifetime varies from one hour up to one week.
      </p>
    </div>
  ) : null;

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
