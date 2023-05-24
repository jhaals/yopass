import { useRouter } from 'next/router';
import { backendDomain } from '../utils';

const useDownloadPath = () => {
  const router = useRouter();
  const [prefix, key, urlPassword] = router.asPath.split('#');
  const isFile = prefix.startsWith('/f');
  const url = isFile
    ? `${backendDomain}/file/${key}`
    : `${backendDomain}/secret/${key}`;
  return { url, urlPassword };
};

export default useDownloadPath;
