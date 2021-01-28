import { useTranslation } from 'react-i18next';
import { makeStyles, Typography } from '@material-ui/core';

const useStyles = makeStyles((theme) => ({
  header: {
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(1),
  },
}));

const Error = (props: { error?: Error }) => {
  const { t } = useTranslation();
  const classes = useStyles();
  if (props.error === undefined) {
    return null;
  }

  return (
    <div>
      <Typography variant="h3">{t('Secret does not exist')}</Typography>
      <Typography variant="h5">
        {t('It might be caused by any of these reasons.')}
      </Typography>
      <br />
      <Typography className={classes.header} variant="h5">
        {t('Opened before')}
      </Typography>
      <Typography variant="subtitle1">
        {t(
          'A secret can be restricted to a single download. It might be lost because the sender clicked this link before you viewed it.',
        )}
        <br />
        {t(
          'The secret might have been compromised and read by someone else. You should contact the sender and request a new secret.',
        )}

        <Typography className={classes.header} variant="h5">
          {t('Broken link')}
        </Typography>
        {t(
          'The link must match perfectly in order for the decryption to work, it might be missing some magic digits.',
        )}
        <Typography className={classes.header} variant="h5">
          {t('Expired')}
        </Typography>
        {t(
          'No secret last forever. All stored secrets will expires and self destruct automatically. Lifetime varies from one hour up to one week.',
        )}
      </Typography>
    </div>
  );
};
export default Error;
