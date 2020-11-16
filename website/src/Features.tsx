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
import { useTranslation } from 'react-i18next';

const Features = () => {
  const { t } = useTranslation();
  return (
    <Container className="features bg-features">
      <hr />
      <h4 className="section-title">{t('Share Secrets Securely With Ease')}</h4>
      <p className="lead text-center">
        {t(
          'Yopass is created to reduce the amount of clear text passwords stored in email and chat conversations by encrypting and generating a short lived link which can only be viewed once.',
        )}
      </p>
      <p />
      <Row>
        <Feature title={t('End-to-end Encryption')} icon={faLock}>
          {t(
            'Encryption and decryption are being made locally in the browser. The key is never stored with yopass.',
          )}
        </Feature>
        <Feature title={t('Self destruction')} icon={faBomb}>
          {t(
            'Encrypted messages have a fixed lifetime and will be deleted automatically after expiration.',
          )}
        </Feature>
        <Feature title={t('One-time downloads')} icon={faDownload}>
          {t(
            'The encrypted message can only be downloaded once which reduces the risk of someone peaking your secrets.',
          )}
        </Feature>
        <Feature title={t('Simple Sharing')} icon={faShareAlt}>
          {t(
            'Yopass generates a unique one click link for the encrypted file or message. The decryption password can alternatively be sent separately.',
          )}
        </Feature>
        <Feature title={t('No accounts needed')} icon={faUserAltSlash}>
          {t(
            'Sharing should be quick and easy; No additional information except the encrypted secret is stored in the database.',
          )}
        </Feature>
        <Feature title={t('Open Source Software')} icon={faCodeBranch}>
          {t(
            'Yopass encryption mechanism are built on open source software meaning full transparancy with the possibility to audit and submit features.',
          )}
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
//     <div className="col-lg-4 col-sm-6 col-md-6">
//       <div className="feature-box">
//         <div className="feature-img-icon">
//           <FontAwesomeIcon color="black" size="4x" icon={props.icon} />
//         </div>
//         <div className="feature-inner">
//           <h4>{props.title}</h4>
//           <p>{props.children}</p>
//         </div>
//       </div>
//     </div>
  );
};
export default Features;
