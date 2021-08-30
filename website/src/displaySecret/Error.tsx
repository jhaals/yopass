import { useTranslation } from 'react-i18next';
import { makeStyles, Typography } from '@material-ui/core';

const useStyles = makeStyles((theme) => ({
  header: {
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(1),
  },
}));

const ErrorPage = (props: { error?: Error }) => {
  const { t } = useTranslation();
  const classes = useStyles();
  if (!props.error) {
    return null;
  }

  return (
    <div>
      <Typography variant="h4">
        {t('error.title')}
      </Typography>
      <Typography variant="h5">
        {t('error.subtitle')}
      </Typography>
      <br />
      <Typography className={classes.header} variant="h5">
        {t('error.titleOpened')}
      </Typography>
      <Typography variant="subtitle1">
        {t('error.subtitleOpenedBefore')}
        <br />
        {t('error.subtitleOpenedCompromised')}
        <Typography className={classes.header} variant="h5">
          {t('error.titleBrokenLink')}
        </Typography>
        {t('error.subtitleBrokenLink')}
        <Typography className={classes.header} variant="h5">
          {t('error.titleExpired')}
        </Typography>
        {t('error.subtitleExpired')}
      </Typography>
    </div>
  );
};
export default ErrorPage;
