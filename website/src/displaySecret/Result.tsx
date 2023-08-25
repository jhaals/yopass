import { faCopy, faEnvelope } from '@fortawesome/free-solid-svg-icons';
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
  Box,
} from '@mui/material';
import { useTranslation } from 'react-i18next';

type ResultProps = {
  readonly uuid: string;
  readonly password: string;
  readonly prefix: 's' | 'f';
  readonly customPassword?: boolean;
};

const Result = ({ uuid, password, prefix, customPassword }: ResultProps) => {
  const base =
    (process.env.PUBLIC_URL ||
      `${window.location.protocol}//${window.location.host}`) + `/#/${prefix}`;
  const short = `${base}/${uuid}`;
  const full = `${short}/${password}`;
  const oneClickLink = process.env.REACT_APP_DISABLE_ONE_CLICK_LINK !== '1';
  const { t } = useTranslation();

  return (
    <Box>
      <Typography variant="h4">{t('result.title')}</Typography>
      <Typography>
        {t('result.subtitleDownloadOnce')}
        <br />
        {t('result.subtitleChannel')}
      </Typography>
      <TableContainer>
        <Table>
          <TableBody>
            {oneClickLink && !customPassword && (
              <Row label={t('result.rowLabelOneClick')} value={full} />
            )}
            <Row label={t('result.rowLabelShortLink')} value={short} />
            <Row label={t('result.rowLabelDecryptionKey')} value={password} />
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};

type RowProps = {
  readonly label: string;
  readonly value: string;
};

const Row = ({ label, value }: RowProps) => {
  const [copy, copyToClipboard] = useCopyToClipboard();
  const { t } = useTranslation();
  return (
    <TableRow key={label}>
      <TableCell width="15" padding="none">
        <Button
          color={copy.error ? 'secondary' : 'primary'}
          variant="contained"
          onClick={() => copyToClipboard(value)}
          startIcon={<FontAwesomeIcon icon={faCopy} />}
        >
          {t('result.buttonCopy')}
        </Button>
      </TableCell>
      <TableCell width="15" >
        {label != 'Decryption Key' &&
          <Button
            color='primary'
            variant="contained"
            onClick={() => ButtonMailto(label, value)}
            startIcon={<FontAwesomeIcon icon={faEnvelope} />}
          >
            {t('result.buttonEmail')}
          </Button>}
      </TableCell>
      <TableCell width="100" padding="none">
        <strong>{label}</strong>
      </TableCell>
      <TableCell>{value}</TableCell>
    </TableRow>
  );
};

const ButtonMailto = (label: string, value: string) => {
  return (
    window.location.href = `mailto:?subject=One-time%20Secret%20-%20${label}&body=Hi%0d%0a%0d%0aThe%20link%20below%20contains%20a%20one-time%20secret%20'${label}'%0d%0a%0d%0a${value}`
  );
};

export default Result;
