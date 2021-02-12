import {
  faBomb,
  faCodeBranch,
  faDownload,
  faLock,
  faShareAlt,
  faUserAltSlash,
  IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useTranslation } from 'react-i18next';
import {
  createStyles,
  Grid,
  makeStyles,
  Paper,
  Typography,
  Divider,
  Box,
} from '@material-ui/core';

const useStyles = makeStyles((theme) =>
  createStyles({
    feature: {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: 230,
      padding: 16,
    },
    featureHeader: {
      padding: 10,
    },
    divider: {
      padding: theme.spacing(1),
    },
    header: {
      padding: theme.spacing(2),
    },
  }),
);

export const Features = () => {
  const { t } = useTranslation();
  return (
    <Grid container={true} spacing={2}>
      <Grid item={true} xs={12}>
        <Divider />
        <Box p={2}>
          <Typography variant="h5" align={'center'}>
            {t('Share Secrets Securely With Ease')}
          </Typography>
          <Typography variant="body2" align={'center'}>
            {t(
              'Yopass is created to reduce the amount of clear text passwords stored in email and chat conversations by encrypting and generating a short lived link which can only be viewed once.',
            )}
          </Typography>
        </Box>
      </Grid>
      <Feature title={t('End-to-end Encryption')} icon={faLock}>
        {t(
          'Encryption and decryption are being made locally in the browser. The key is never stored with yopass.',
        )}
      </Feature>
      <Feature title={t('Self destruction')} icon={faBomb}>
        {t(
          'Encrypted messages have a fixed lifetime and will be deleted automatically after expiration.',
        )}
      </Feature>
      <Feature title={t('One-time downloads')} icon={faDownload}>
        {t(
          'The encrypted message can only be downloaded once which reduces the risk of someone peaking your secrets.',
        )}
      </Feature>
      <Feature title={t('Simple Sharing')} icon={faShareAlt}>
        {t(
          'Yopass generates a unique one click link for the encrypted file or message. The decryption password can alternatively be sent separately.',
        )}
      </Feature>
      <Feature title={t('No accounts needed')} icon={faUserAltSlash}>
        {t(
          'Sharing should be quick and easy; No additional information except the encrypted secret is stored in the database.',
        )}
      </Feature>
      <Feature title={t('Open Source Software')} icon={faCodeBranch}>
        {t(
          'Yopass encryption mechanism are built on open source software meaning full transparency with the possibility to audit and submit features.',
        )}
      </Feature>
    </Grid>
  );
};

type FeatureProps = {
  readonly title: string;
  readonly icon: IconDefinition;
  readonly children: JSX.Element;
};

const Feature = (props: FeatureProps) => {
  const classes = useStyles();
  return (
    <Grid item={true} xs={12} md={4}>
      <Paper className={classes.feature}>
        <FontAwesomeIcon color={'black'} size={'4x'} icon={props.icon} />
        <Typography className={classes.featureHeader} variant="h5">
          {props.title}
        </Typography>
        <Typography>{props.children}</Typography>
      </Paper>
    </Grid>
  );
};
