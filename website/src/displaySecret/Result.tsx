import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useCopyToClipboard } from 'react-use';
import { Button, TextField, Grid } from '@material-ui/core';
import { useTranslation } from 'react-i18next';

type ResultProps = {
  readonly uuid: string;
  readonly password: string;
  readonly prefix: string;
};

const Result = (props: ResultProps) => {
  const { uuid, password, prefix } = props;
  const base =
    (process.env.PUBLIC_URL ||
      `${window.location.protocol}//${window.location.host}`) + `/#/${prefix}`;
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
      <Grid container={true} justifyContent={'center'}>
        <Grid item={true} xs={12}>
          {!isCustomPassword && (
            <CopyField label={t('One-click link')} value={full} />
          )}
        </Grid>
        <Grid item={true} xs={12}>
          <CopyField label={t('Short link')} value={short} />
        </Grid>
        <Grid item={true} xs={12}>
          <CopyField label={t('Decryption Key')} value={password} />
        </Grid>
      </Grid>
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
    <>
      <TextField
        id={`copyField_${props.label}`}
        label={props.label}
        fullWidth={true}
        defaultValue={props.value}
        margin={'normal'}
        InputProps={{
          readOnly: true,
          startAdornment: (
            <Button
              color={copy.error ? 'secondary' : 'primary'}
              variant="contained"
              onClick={() => copyToClipboard(props.value)}
            >
              <FontAwesomeIcon icon={faCopy} />
            </Button>
          ),
        }}
      />
    </>
  );
};

export default Result;
