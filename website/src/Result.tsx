import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import * as ClipboardJS from 'clipboard';
import * as React from 'react';
import { Button, FormGroup, Input, Label } from 'reactstrap';

const Result = (
  props: {
    readonly uuid: string;
    readonly password: string;
  } & React.HTMLAttributes<HTMLElement>,
) => {
  const base = `${window.location.protocol}//${window.location.host}/#/s`;
  const short = `${base}/${props.uuid}`;
  const full = `${short}/${props.password}`;

  return (
    <div>
      <h3>Secret stored in database</h3>
      <p>
        Remember that the secret can only be downloaded once so do not open the
        link yourself.
        <br />
        The cautious should send the decryption key in a separate communication
        channel.
      </p>
      <CopyField name="full" label="One-click link" value={full} />
      <CopyField name="short" label="Short link" value={short} />
      <CopyField name="dec" label="Decryption Key" value={props.password} />
    </div>
  );
};

const CopyField = (
  props: {
    readonly label: string;
    readonly name: string;
    readonly value: string;
  } & React.HTMLAttributes<HTMLElement>,
) => {
  // @ts-ignore
  const clip = new ClipboardJS(`#${props.name}-b`, {
    target: () => document.getElementById(`${props.name}-i`),
  });

  return (
    <FormGroup>
      <Label>{props.label}</Label>
      <div className="input-group mb-3">
        <div className="input-group-append">
          <Button color="primary" id={`${props.name}-b`}>
            {' '}
            <FontAwesomeIcon icon={faCopy} />
          </Button>
        </div>
        <Input readOnly={true} id={`${props.name}-i`} value={props.value} />
      </div>
    </FormGroup>
  );
};
export default Result;
