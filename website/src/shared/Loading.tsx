import { Typography } from '@material-ui/core';
import { useTranslation } from 'react-i18next';

const Loading = () => {
  const { t } = useTranslation();
  return (
    <Typography variant="h4">
      {t('Fetching from database and decrypting in browser, please hold...')}
    </Typography>
  );
};

export default Loading;
