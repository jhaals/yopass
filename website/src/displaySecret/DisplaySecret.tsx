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

  const state = useAsync(async () => {
    if (password === undefined) {
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
      {state.loading && <Loading />}
      <Error error={state.error} />
      <Secret secret={state.value} />
      <Form display={!password} uuid={key} prefix={isEncoded ? 'c' : 's'} />
    </div>
  );
};

export default DisplaySecret;
