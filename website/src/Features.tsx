import {
  faBomb,
  faCodeBranch,
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
      <h4 className="section-title">
        Reducing the risk of accidentally exposing passwords
      </h4>
      <p className="lead">
        Yopass is created to reduce the amount of clear text passwords stored in
        email and chat conversations by encrypting and generating a short lived
        link which can only be viewed once.
      </p>
      <p />
      <Row>
        <Feature title="End-to-end Encryption" icon={faLock}>
          Both encryption and decryption are being made <span>locally</span> in
          the browser. The decryption key is <span>never</span> stored with
          yopass.
        </Feature>
        <Feature title="Self destruction" icon={faBomb}>
          All messages have a fixed lifetime and will be deleted automatically
          after expiration.
        </Feature>
        <Feature title="Simple Sharing" icon={faShareAlt}>
          The one click links that Yopass produces is a simple yet effective way
          to quickly share a file or message once.
        </Feature>
        <Feature title="No accounts needed" icon={faUserAltSlash}>
          Sharing should be quick and easy; No additional information except the
          encrypted secret is stored in the database.
        </Feature>
        <Feature title="Open Source Software" icon={faCodeBranch}>
          Yopass encryption mechansism are built on open source software meaning
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
          <FontAwesomeIcon color="gray" size="4x" icon={props.icon} />
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
