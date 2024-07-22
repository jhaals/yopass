import { Container, Link, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

export const Attribution = () => {
  const { t } = useTranslation();

  const translationAttribution = () => {
    return (
      <Typography variant="body2" color="textSecondary" align="center">
        {t('attribution.translatedBy')}{' '}
        <Link href={t<string>('attribution.translatorLink')}>
          {t('attribution.translatorName')}
        </Link>
      </Typography>
    );
  };

  return (
    <Container>
      <Typography
        margin={4}
        variant="body2"
        color="textSecondary"
        align="center"
      >
        {t('attribution.createdBy')}{' '}
        <Link href="https://www.entrata.com/?utm_source=google&utm_medium=cpc&utm_campaign=Brand&utm_term=Entrata&utm_content=everything-you-need&gad_source=1&gclid=CjwKCAjwhvi0BhA4EiwAX25uj2hsUA5V4Ybo_ClG_QuOENqqXQR_BvXs4yONdOjZbg5Lfvj0jH1XpRoCnbAQAvD_BwE">Chase Hughes</Link>
      </Typography>
      {t('attribution.translatorName') && translationAttribution()}
    </Container>
  );
};
