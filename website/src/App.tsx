import * as React from 'react';
import { HashRouter as Router, Route } from 'react-router-dom';
import { Col, Container, Navbar, NavbarBrand, Row } from 'reactstrap';

import './App.css';
import Create from './Create';
import DisplaySecret from './DisplaySecret';

class App extends React.Component {
  public render() {
    return (
      <Router>
        <div>
          <div className="App">
            <Navbar color="dark" dark={true} expand="md">
              <NavbarBrand href="/">Yopass</NavbarBrand>
            </Navbar>
          </div>
          <Container className="margin">
            <Row>
              <Col ml="auto">
                <Route path="/" exact={true} component={Create} />
                <Route
                  exact={true}
                  path="/s/:key/:password"
                  component={DisplaySecret}
                />
                <Route exact={true} path="/s/:key" component={DisplaySecret} />
              </Col>
            </Row>
          </Container>
          <Features />
          <Attribution />
        </div>
      </Router>
    );
  }
}

const Features = () => {
  return (
    <Container className="features">
      <hr />
      <p className="lead">
        {' '}
        Yopass is created to reduce the amount of clear text passwords stored in
        email and chat conversations by encrypting and generating a short lived
        link which can only be viewed once.
      </p>
      <p />
      <h6>End-to-End encryption</h6>
      <p>
        Both encryption and decryption are being made locally in the browser,
        the decryption key is not stored with yopass.
      </p>
      <h6>Self destruction</h6>
      <p>
        All messages have a fixed time to live and will be deleted automatically
        after expiration.
      </p>
      <h6>No accounts needed</h6>
      <p>
        No additional information except the encrypted secret is stored in the
        database.
      </p>
      <h6>Open source software</h6>
      <p>
        Yopass fully open source meaning full transparency and the possibility
        to submit features, fix bugs or run the software yourself.
      </p>
    </Container>
  );
};

const Attribution = () => {
  return (
    <Container className="text-center">
      <div className="text-muted small">
        Created by <a href="https://github.com/jhaals/yopass">Johan Haals</a>
      </div>
    </Container>
  );
};
export default App;
