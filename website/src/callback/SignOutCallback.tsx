import { FC, useEffect } from 'react';
import { useHistory } from 'react-router';
import { useAuth } from 'oidc-react';

const SignOutCallback: FC = () => {
  const history = useHistory();
  const auth = useAuth();

  useEffect(() => {
    auth.userManager.signoutRedirectCallback(window.location.href).then(() => {
      history.push('/');
    });
  }, [auth.userManager, history]);

  return <p>Redirecting...</p>;
};

export default SignOutCallback;
