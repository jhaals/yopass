import { useLocation, useParams } from 'react-router-dom';
import Error from './Error';
import Form from '../createSecret/Form';
import { backendDomain, decryptMessage } from '../utils/utils';
import { useAsync } from 'react-use';
import Loading from '../shared/Loading';
import Secret from './Secret';

export type DisplayParams = {
  key: string;
  password: string;
};

const DisplaySecret = () => {
  const { key, password } = useParams<DisplayParams>();
  const location = useLocation();
  const isEncoded = null !== location.pathname.match(/\/c\//);

  const { value, error, loading } = useAsync(async () => {
    if (!password) {
      return;
    }
    const request = await fetch(`${backendDomain}/secret/${key}`);
    const data = await request.json();
    const r = await decryptMessage(
      data.message,
      isEncoded ? atob(password) : password,
      'utf8',
    );
    return r.data as string;
  }, [isEncoded, password, key]);

  return (
    <div>
      {loading && <Loading />}
      <Error error={error} />
      <Secret secret={value} />
      {!password && <Form uuid={key} prefix={isEncoded ? 'c' : 's'} />}
    </div>
  );
};

export default DisplaySecret;
