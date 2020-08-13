import * as React from 'react';
import { useState } from 'react';
import { Redirect } from 'react-router-dom';
import { Button, Col, FormGroup, Input, Label } from 'reactstrap';
import { useTranslation } from 'react-i18next';

const Form = (
  props: {
    readonly display: boolean;
    readonly uuid: string | undefined;
    readonly prefix: string;
  } & React.HTMLAttributes<HTMLElement>,
) => {
  const [password, setPassword] = useState('');
  const [redirect, setRedirect] = useState(false);
  const { t } = useTranslation();

  const doRedirect = () => {
    if (password) {
      setRedirect(true);
    }
  };

  if (redirect) {
    // Base64 encode the password to support special characters
    return <Redirect to={`/${props.prefix}/${props.uuid}/${btoa(password)}`} />;
  }
  return props.display ? (
    <Col sm="6">
      <FormGroup>
        <Label>{t("A decryption key is required, please enter it below")}</Label>
        <Input
          type="text"
          autoFocus={true}
          placeholder={t("Decryption Key")}
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
      </FormGroup>
      <Button block={true} size="lg" onClick={doRedirect}>
        {t("Decrypt Secret")}
      </Button>
    </Col>
  ) : null;
};
export default Form;
