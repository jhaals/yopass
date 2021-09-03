import { FC, useEffect } from 'react';
import { useHistory } from 'react-router';
import { useAuth } from 'oidc-react';

const SignInCallback: FC = () => {
  const history = useHistory();
  const auth = useAuth();

  useEffect(() => {
    auth.userManager.signinRedirectCallback(window.location.href).then(() => {
      history.push('/create');
    });
  }, [auth.userManager, history]);

  return <p>Redirecting...</p>;
};

export default SignInCallback;
