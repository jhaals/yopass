import { FC, useEffect } from "react";
import { useHistory } from 'react-router';
import { useAuth } from 'oidc-react';

const Callback: FC = () => {
  const history = useHistory();
  const auth = useAuth();

  useEffect(() => {
    auth.userManager.signinRedirectCallback(window.location.href).then(() => {
      history.push('/create');
    })
  }, []);

  return <p>Redirecting...</p>
}

export default Callback;
