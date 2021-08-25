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
  readonly customPassword?: boolean;
};

const Result = ({ uuid, password, prefix, customPassword }: ResultProps) => {
  const base =
    (process.env.PUBLIC_URL ||
      `${window.location.protocol}//${window.location.host}`) + `/#`;

  const short = `${base}/${prefix}/${uuid}`;
  const full = `${short}/${password}`;
  const clickThroughShort = `${base}/c/${prefix}/${uuid}`;
  const clickThroughFull = `${clickThroughShort}/${password}`;
  const { t } = useTranslation();

  return (
    <Box>
      <Typography variant="h4">{t('result.title')}</Typography>
      <TableContainer>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell colSpan={3}>
                <Typography>
                  {t('result.subtitleDownloadOnce')}
                  <br />
                  {t('result.subtitleChannel')}
                </Typography>
              </TableCell>
            </TableRow>
            {!customPassword && (
              <Row label={t('result.rowLabelOneClick')} value={full} />
            )}
            <Row label={t('result.rowLabelShortLink')} value={short} />
            <Row label={t('result.rowLabelDecryptionKey')} value={password} />
            <TableRow>
              <TableCell colSpan={3}>
                <Typography>{t('result.subtitleClickThrough')}</Typography>
              </TableCell>
            </TableRow>
            {!customPassword && (
              <Row
                label={t('result.rowLabelClickThroughOneClick')}
                value={clickThroughFull}
              />
            )}
            <Row
              label={t('result.rowLabelClickThroughShortLink')}
              value={clickThroughShort}
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
      <TableCell width="100" padding="none">
        <strong>{label}</strong>
      </TableCell>
      <TableCell>{value}</TableCell>
    </TableRow>
  );
};

export default Result;
