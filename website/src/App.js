import React, { Component } from "react";
import { Navbar, NavbarBrand, Container, Row, Col } from "reactstrap";
import { HashRouter as Router, Route } from "react-router-dom";
import Create from "./Create";
import CreateResult from "./CreateResult";
import DisplaySecret from "./DisplaySecret";
class App extends Component {
  render() {
    return (
      <Router>
        <div className="App">
          <Navbar color="dark" dark expand="md">
            <NavbarBrand href="/">Yopass</NavbarBrand>
          </Navbar>
          <div>
            <Container className="margin">
              <Row>
                <Col ml="auto">
                  <Route exact path="/" component={Create} />
                  <Route exact path="/result" component={CreateResult} />
                  <Route
                    exact
                    path="/s/:key/:password"
                    component={DisplaySecret}
                  />
                  <Route exact path="/s/:key" component={DisplaySecret} />
                </Col>
              </Row>
            </Container>
            <Container className="features">
              <hr />
              <p className="lead">
                {" "}
                Yopass is created to reduce the amount of clear text passwords
                stored in email and chat conversations by encrypting and
                generating a short lived link which can only be viewed once.
              </p>
              <p />
              <h6>End-to-End encryption</h6>
              <p>
                Both encryption and decryption are being made locally in the
                browser, the decryption key is not stored with yopass.
              </p>
              <h6>Self destruction</h6>
              <p>
                All messages have a fixed time to live and will be deleted
                automatically after expiration.
              </p>
              <h6>No accounts needed</h6>
              <p>
                No additional information except the encrypted secret is stored
                in the database.
              </p>
              <h6>Open source software</h6>
              <p>
                Yopass fully open source meaning full transparency and the
                possibility to submit features, fix bugs or run the software
                yourself.
              </p>
            </Container>
          </div>
          <Container className="text-center">
            <div className="text-muted small">
              Created by{" "}
              <a href="https://github.com/jhaals/yopass">Johan Haals</a>
            </div>
          </Container>
        </div>
      </Router>
    );
  }
}

export default App;
