import { FC, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from 'oidc-react';

const SignOutCallback: FC = () => {
  const navigate = useNavigate();
  const auth = useAuth();

  useEffect(() => {
    auth.userManager.signoutRedirectCallback(window.location.href).then(() => {
      navigate('/');
    });
  }, [auth.userManager, navigate]);

  return <p>Redirecting...</p>;
};

export default SignOutCallback;
