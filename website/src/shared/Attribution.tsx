import * as React from 'react';
import { Container } from 'reactstrap';
import { useTranslation } from 'react-i18next';

export const Attribution: React.FC = () => {
  const { t } = useTranslation();
  return (
    <Container className="text-center">
      <div className="text-muted small footer">
        {t('Created by')}{' '}
        <a href="https://github.com/jhaals/yopass">{t('Johan Haals')}</a>
      </div>
    </Container>
  );
};
