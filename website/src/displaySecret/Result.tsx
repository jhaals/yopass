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
  Box,
} from '@material-ui/core';
import { useTranslation } from 'react-i18next';

type ResultProps = {
  readonly uuid: string;
  readonly password: string;
  readonly prefix: 's' | 'f';
};

const Result = ({ uuid, password, prefix }: ResultProps) => {
  const base =
    (process.env.PUBLIC_URL ||
      `${window.location.protocol}//${window.location.host}`) + `/#/${prefix}`;
  const short = `${base}/${uuid}`;
  const full = `${short}/${password}`;
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
        <Table style={{ fontFamily: 'Red Hat Display, sans-serif' }}>
          <TableBody>
            <Row
              data-test-id="rowLabelOneClick"
              label={t('result.rowLabelOneClick')}
              value={full}
            />
            <Row
              data-test-id="rowLabelShortLink"
              label={t('result.rowLabelShortLink')}
              value={short}
            />
            <Row
              data-test-id="rowLabelDecryptionKey"
              label={t('result.rowLabelDecryptionKey')}
              value={password}
            />
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
      <TableCell padding="none">
        <strong>{label}</strong>
      </TableCell>
      <TableCell>{value}</TableCell>
    </TableRow>
  );
};

export default Result;
