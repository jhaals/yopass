import { Container, Link, makeStyles, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

const useStyles = makeStyles((theme) => ({
  attribution: {
    margin: theme.spacing(4),
  },
}));

export const Attribution = () => {
  const { t } = useTranslation();
  const classes = useStyles();

  const translationAttribution = () => {
    return (
      <Typography variant="body2" color="textSecondary" align="center">
        {t('attribution.translatedBy')}{' '}
        <Link href={t('attribution.translatorLink')}>
          {t('attribution.translatorName')}
        </Link>
      </Typography>
    );
  };

  return (
    <Container className={classes.attribution}>
      <Typography variant="body2" color="textSecondary" align="center">
        {t('attribution.createdBy')}{' '}
        <Link href="https://github.com/3lvia/onetime-yopass">Johan Haals</Link>
      </Typography>
      {t('attribution.translatorName') && translationAttribution()}
    </Container>
  );
};
