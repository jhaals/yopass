import React, { Component } from "react";
import sjcl from "sjcl";
import { Button, FormGroup, Label, Input, Col } from "reactstrap";
export default class CreateForm extends Component {
  constructor(props) {
    super(props);
    this.state = {
      password: "",
      message: "",
      displayForm: false,
      displayError: false,
      loading: true
    };
    if (this.props.match.params.password) {
      this.state.password = this.props.match.params.password;
    }
    this.decrypt = this.decrypt.bind(this);
  }
  componentDidMount() {
    if (!this.state.password) {
      this.setState({ displayForm: true, loading: false });
    } else {
      this.decrypt();
    }
  }
  decrypt() {
    this.setState({ loading: true, displayForm: false });
    const url = process.env.REACT_APP_BACKEND_URL
      ? `${process.env.REACT_APP_BACKEND_URL}/secret`
      : "/secret";
    fetch(`${url}/${this.props.match.params.key}`)
      .then(r => {
        if (r.status !== 200) {
          this.setState({
            displayError: true,
            displayForm: false,
            loading: false
          });
          return;
        }
        r.json()
          .then(j => {
            const message = sjcl.decrypt(this.state.password, j.message);
            this.setState({ message, displayForm: false, loading: false });
          })
          .catch(err => {
            console.log(err);
            this.setState({
              displayError: true,
              displayForm: false,
              loading: false
            });
          });
      })
      .catch(e => {
        console.log(e);
        this.setState({
          displayError: true,
          displayForm: false,
          loading: false
        });
      });
  }
  render() {
    return (
      <div>
        {this.state.loading && (
          <h3>
            Fetching from database and decrypting in browser, please hold...
          </h3>
        )}
        {this.state.message && (
          <div>
            <h1>Decrypted Message</h1>
            This secret will not be viewable again, make sure to save it now!
            <pre>{this.state.message}</pre>
          </div>
        )}
        {this.state.displayError && (
          <div>
            <h2>Secret does not exist</h2>
            <p className="lead">
              It might be caused by <b>any</b> of these reasons.
            </p>
            <h4>Opened before</h4>A secret can only be displayed ONCE. It might
            be lost due to a non-techy sender that clicked the URL before
            sending it to you.
            <p>
              The secret might have been compromised and read by someone else.
              You should contact the sender and request a new secret
            </p>
            <h4>Incorrect URL</h4>
            <p>The URL you've been given might be missing some magic digits</p>
            <h4>Expired</h4>
            <p>
              No secrets last forever. All stored secrets will expires and self
              destruct automatically. Lifetime varies from one hour up to one
              week
            </p>
          </div>
        )}
        {this.state.displayForm && (
          <div>
            <Col sm="6">
              <FormGroup>
                <Label>
                  A decryption key is required, please enter it below
                </Label>
                <Input
                  type="input"
                  autoFocus="autofocus"
                  placeholder="Decryption Key"
                  value={this.state.password}
                  onChange={event =>
                    this.setState({ password: event.target.value })
                  }
                />
              </FormGroup>
              <Button block size="lg" onClick={this.decrypt}>
                Decrypt Secret
              </Button>
            </Col>
          </div>
        )}
      </div>
    );
  }
}
