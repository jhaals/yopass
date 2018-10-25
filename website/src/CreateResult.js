import React, { Component } from "react";
import { Button, FormGroup, Label, Input, Col } from "reactstrap";
import Clipboard from "clipboard";

export default class Create extends Component {
  constructor(props) {
    super(props);
    if (!this.props.location.state) return;
    const base_url = `${window.location.protocol}//${window.location.host}/#/s`;
    const short_url = `${base_url}/${this.props.location.state.key}`;
    const full_url = `${short_url}/${this.props.location.state.password}`;
    this.state = {
      short_url: short_url,
      full_url: full_url,
      password: this.props.location.state.password
    };
  }

  componentDidMount() {
    if (!this.props.location.state) return;
    for (let i of ["full", "short", "password"]) {
      new Clipboard(document.getElementById(`${i}-b`), {
        target: () => document.getElementById(`${i}-i`)
      });
    }
  }
  render() {
    return (
      <div>
        {this.props.location.state && (
          <div>
            <Col sm="6">
              <h3>Secret stored in database</h3>

              <FormGroup>
                <Label>One-click link</Label>
                <div className="input-group mb-3">
                  <Input
                    id="full-i"
                    type="input"
                    readOnly
                    value={this.state.full_url}
                  />
                  <div className="input-group-append">
                    <Button id="full-b">Copy</Button>
                  </div>
                </div>
              </FormGroup>
              <FormGroup>
                <Label>Short link</Label>
                <div className="input-group mb-3">
                  <Input
                    id="short-i"
                    type="input"
                    readOnly
                    value={this.state.short_url}
                  />
                  <div className="input-group-append">
                    <Button id="short-b">Copy</Button>
                  </div>
                </div>
              </FormGroup>

              <FormGroup>
                <Label>Decryption Key</Label>
                <div className="input-group mb-3">
                  <Input
                    type="input"
                    readOnly
                    id="password-i"
                    value={this.props.location.state.password}
                  />
                  <div className="input-group-append">
                    <Button id="password-b">Copy</Button>
                  </div>
                </div>
              </FormGroup>
            </Col>
          </div>
        )}
      </div>
    );
  }
}
