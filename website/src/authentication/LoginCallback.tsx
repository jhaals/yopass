import { FC } from 'react'
import { useHistory } from "react-router-dom"
import { CallbackComponent } from 'redux-oidc'
import userManager from "../services/userManager";

const LoginCallback: FC = () => {
  const history = useHistory();
  console.log("LoginCallback!")
  return (
    <CallbackComponent
      userManager={userManager}
      successCallback={() => {
        if (process.env.NODE_ENV !== 'production') {
          console.log("LoginCallback, Success!");
        }
        history.push("/create");
      }}
      errorCallback={() => {
        if (process.env.NODE_ENV !== 'production') {
          console.log("LoginCallback, Error!")
        }
        history.push("/blank");
      }}
    >
    </CallbackComponent>
  )
}

export default LoginCallback
