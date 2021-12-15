import { useTranslation } from 'react-i18next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import React from 'react';

export async function getStaticProps({ locale }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  };
}

export const Footer = () => {
  const { t } = useTranslation();

  return (
    <footer>
      <p>{t('header.buttonHome')}</p>
    </footer>
  );
};
export default Footer;
