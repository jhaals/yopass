import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useCopyToClipboard } from 'react-use';
import {
  Button,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
} from '@material-ui/core';
import { useTranslation } from 'react-i18next';
import React from 'react';

type ResultProps = {
  readonly uuid: string;
  readonly password: string;
  readonly customPassword: boolean;
};

const Result = ({ uuid, password, customPassword }: ResultProps) => {
  const base =
    (process.env.PUBLIC_URL ||
      `${window.location.protocol}//${window.location.host}`) + `/#/s`;
  const short = `${base}/${uuid}`;
  const full = `${short}/${password}`;
  const { t } = useTranslation();

  return (
    <div>
      <Typography variant="h4">{t('Secret stored in database')}</Typography>
      <Typography>
        {t(
          'Remember that the secret can only be downloaded once so do not open the link yourself.',
        )}
        <br />
        {t(
          'The cautious should send the decryption key in a separate communication channel.',
        )}
      </Typography>
      <TableContainer>
        <Table>
          <TableBody>
            {!customPassword && (
              <Row label={t('One-click link')} value={full} />
            )}
            <Row label={t('Short link')} value={short} />
            <Row label={t('Decryption Key')} value={password} />
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
};

type RowProps = {
  readonly label: string;
  readonly value: string;
};

const Row = ({ label, value }: RowProps) => {
  const [copy, copyToClipboard] = useCopyToClipboard();
  return (
    <TableRow key={label}>
      <TableCell width="15">
        <Button
          color={copy.error ? 'secondary' : 'primary'}
          variant="contained"
          onClick={() => copyToClipboard(value)}
        >
          <FontAwesomeIcon icon={faCopy} />
        </Button>
      </TableCell>
      <TableCell width="100" padding="none">
        <strong>{label}</strong>
      </TableCell>
      <TableCell>{value}</TableCell>
    </TableRow>
  );
};

export default Result;
