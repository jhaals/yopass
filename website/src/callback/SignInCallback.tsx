import { FC, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from 'oidc-react';

const SignInCallback: FC = () => {
  const navigate = useNavigate();
  const auth = useAuth();

  useEffect(() => {
    auth.userManager.signinRedirectCallback(window.location.href).then(() => {
      navigate('/create');
    });
  }, [auth.userManager, navigate]);

  return <p>Redirecting...</p>;
};

export default SignInCallback;
