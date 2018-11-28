import * as ClipboardJS from 'clipboard';
import * as React from 'react';
import { Button, Col, FormGroup, Input, Label } from 'reactstrap';

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
      <div>
        <Col sm="6">
          <h3>Secret stored in database</h3>
          <CopyField name="full" label="One-click link" value={full} />
          <CopyField name="short" label="Short link" value={short} />
          <CopyField name="dec" label="Decryption Key" value={props.password} />
        </Col>
      </div>
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
        <Input readOnly={true} id={`${props.name}-i`} value={props.value} />
        <div className="input-group-append">
          <Button id={`${props.name}-b`}>Copy</Button>
        </div>
      </div>
    </FormGroup>
  );
};
export default Result;
