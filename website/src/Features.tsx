import {
  faBomb,
  faCodeBranch,
  faDownload,
  faLock,
  faShareAlt,
  faUserAltSlash,
  IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import * as React from 'react';
import { Container, Row } from 'reactstrap';

const Features = () => {
  return (
    <Container className="features bg-features">
      <hr />
      <h4 className="section-title">Share Secrets Securely With Ease</h4>
      <p className="lead text-center">
        Yopass is created to reduce the amount of clear text passwords stored in
        email and chat conversations by encrypting and generating a short lived
        link which can only be viewed once.
      </p>
      <p />
      <Row>
        <Feature title="End-to-end Encryption" icon={faLock}>
          Encryption and decryption are being made <span>locally</span> in the
          browser. The key is <span>never</span> stored with yopass.
        </Feature>
        <Feature title="Self destruction" icon={faBomb}>
          Encrypted messages have a fixed lifetime and will be deleted
          automatically after expiration.
        </Feature>
        <Feature title="One-time downloads" icon={faDownload}>
          The encrypted message can only be downloaded once which reduces the
          risk of someone peaking your secrets.
        </Feature>
        <Feature title="Simple Sharing" icon={faShareAlt}>
          Yopass generates a unique one click link for the encrypted file or
          message. The decryption password can alternatively be sent separately.
        </Feature>
        <Feature title="No accounts needed" icon={faUserAltSlash}>
          Sharing should be quick and easy; No additional information except the
          encrypted secret is stored in the database.
        </Feature>
        <Feature title="Open Source Software" icon={faCodeBranch}>
          Yopass encryption mechanism are built on open source software meaning
          full transparancy with the possibility to audit and submit features.
        </Feature>
      </Row>
    </Container>
  );
};

const Feature = (
  props: {
    readonly title: string;
    readonly icon: IconDefinition;
  } & React.HTMLAttributes<HTMLElement>,
) => {
  return (
    <div className="col-lg-4 col-sm-6 col-md-6">
      <div className="feature-box">
        <div className="feature-img-icon">
          <FontAwesomeIcon color="black" size="4x" icon={props.icon} />
        </div>
        <div className="feature-inner">
          <h4>{props.title}</h4>
          <p>{props.children}</p>
        </div>
      </div>
    </div>
  );
};
export default Features;
