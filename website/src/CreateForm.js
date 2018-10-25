import React, { Component } from "react";
import {
  Button,
  Form,
  FormGroup,
  Label,
  Input,
  FormText,
  Alert
} from "reactstrap";

export default class CreateForm extends Component {
  render() {
    return (
      <div>
        <h1>Encrypt message</h1>
        {this.props.error && <Alert color="danger">{this.props.error}</Alert>}
        <Form>
          <FormGroup>
            <Label for="exampleText">Secret message</Label>
            <Input
              rows="4"
              type="textarea"
              name="text"
              onChange={this.props.handleChange("secret")}
              value={this.props.secret}
              autoFocus="autofocus"
              placeholder="Message to encrypt locally in your browser"
            />
          </FormGroup>
          <FormGroup tag="fieldset">
            <Label>Lifetime</Label>
            <FormText color="muted">
              The encrypted message will be deleted automatically after
            </FormText>
            <FormGroup check>
              <Label check>
                <Input
                  type="radio"
                  name="1h"
                  value="3600"
                  onChange={this.props.handleChange("lifetime")}
                  checked={this.props.lifetime === "3600"}
                />One Hour
              </Label>
            </FormGroup>
            <FormGroup check>
              <Label check>
                <Input
                  type="radio"
                  name="1d"
                  value="86400"
                  onChange={this.props.handleChange("lifetime")}
                  checked={this.props.lifetime === "86400"}
                />One Day
              </Label>
            </FormGroup>
            <FormGroup check disabled>
              <Label check>
                <Input
                  type="radio"
                  name="1w"
                  value="604800"
                  onChange={this.props.handleChange("lifetime")}
                  checked={this.props.lifetime === "604800"}
                />One Week
              </Label>
            </FormGroup>
          </FormGroup>
          <Button
            disabled={this.props.loading}
            color="primary"
            size="lg"
            block
            onClick={this.props.handleChange("encrypt")}
          >
            {this.props.loading ? (
              <span>Encrypting message...</span>
            ) : (
              <span>Encrypt Message</span>
            )}
          </Button>
        </Form>
      </div>
    );
  }
}
