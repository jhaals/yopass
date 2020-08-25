import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import Clipboard from 'clipboard';
import * as React from 'react';
import { Button, FormGroup, Input, Label } from 'reactstrap';
import { useTranslation } from 'react-i18next';

const Result = (
  props: {
    readonly uuid: string;
    readonly password: string;
    readonly prefix: string;
  } & React.HTMLAttributes<HTMLElement>,
) => {
  const { uuid, password, prefix } = props;
  const base = `${window.location.protocol}//${window.location.host}/#/${prefix}`;
  const short = `${base}/${uuid}`;
  const customPassword = prefix === 'c' || prefix === 'd';
  const full = `${short}/${password}`;
  const { t } = useTranslation();

  return (
    <div>
      <h3>{t('Secret stored in database')}</h3>
      <p>
        {t(
          'Remember that the secret can only be downloaded once so do not open the link yourself.',
        )}
        <br />
        {t(
          'The cautious should send the decryption key in a separate communication channel.',
        )}
      </p>
      {!customPassword && (
        <CopyField name="full" label={t('One-click link')} value={full} />
      )}
      <CopyField name="short" label={t('Short link')} value={short} />
      <CopyField name="dec" label={t('Decryption Key')} value={password} />
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
  new Clipboard(`#${props.name}-b`, {
    target: () => document.getElementById(`${props.name}-i`) as Element,
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
