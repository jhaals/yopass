import { useState } from 'react';
import useSWR from 'swr';
import Secret from '../src/components/Secret';
import ErrorPage from '../src/components/create/Error';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import EnterDecryptionKey from '../src/components/EnterDecryptionKey';
import useDownloadPath from '../src/hooks/useDownloadPath';

export async function getStaticProps({ locale }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  };
}

const fetcher = async (url: string) => {
  const request = await fetch(url);
  if (!request.ok) {
    throw new Error('Failed to fetch secret');
  }
  return await request.json();
};

const DisplaySecret = () => {
  const { url, urlPassword } = useDownloadPath();
  const [password, setPassword] = useState(urlPassword ?? '');

  const { data, error } = useSWR(password ? url : null, fetcher, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  if (error) {
    return <ErrorPage error={error} />;
  }

  if (data) {
    return <Secret data={data} password={password} />;
  }
  return (
    <EnterDecryptionKey
      password=""
      setPassword={setPassword}
      loaded={Boolean(data)}
    />
  );
};

export default DisplaySecret;
