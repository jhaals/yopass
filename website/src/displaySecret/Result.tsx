import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useCopyToClipboard } from 'react-use';
import { Button, FormGroup, Input, Label } from 'reactstrap';
import { useTranslation } from 'react-i18next';

type ResultProps = {
  readonly uuid: string;
  readonly password: string;
  readonly prefix: string;
};

const Result = (props: ResultProps) => {
  const { uuid, password, prefix } = props;
  const base = `${window.location.protocol}//${window.location.host}/#/${prefix}`;
  const short = `${base}/${uuid}`;
  const full = `${short}/${password}`;
  const isCustomPassword = prefix === 'c' || prefix === 'd';
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
      {!isCustomPassword && (
        <CopyField label={t('One-click link')} value={full} />
      )}
      <CopyField label={t('Short link')} value={short} />
      <CopyField label={t('Decryption Key')} value={password} />
    </div>
  );
};

type CopyFieldProps = {
  readonly label: string;
  readonly value: string;
};

const CopyField = (props: CopyFieldProps) => {
  const [copy, copyToClipboard] = useCopyToClipboard();

  return (
    <FormGroup>
      <Label>{props.label}</Label>
      <div className="input-group mb-3">
        <div className="input-group-append">
          <Button
            color={copy.error ? 'danger ' : 'primary'}
            onClick={() => copyToClipboard(props.value)}
          >
            <FontAwesomeIcon icon={faCopy} />
          </Button>
        </div>
        <Input readOnly={true} value={props.value} />
      </div>
    </FormGroup>
  );
};

export default Result;
