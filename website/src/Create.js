import React, { Component } from "react";
import CreateForm from "./CreateForm";
import { Redirect } from "react-router";
import sjcl from "sjcl";

export default class Create extends Component {
  constructor(props) {
    super(props);
    this.state = {
      loading: false,
      secret: "",
      lifetime: "3600",
      error: "",
      password: ""
    };
    this.handleChange = this.handleChange.bind(this);
  }
  handleChange = name => event => {
    if (name === "encrypt") {
      this.encryptSecret();
      return;
    }
    this.setState({
      [name]: event.target.value
    });
  };
  encryptSecret() {
    if (this.state.secret.length === 0) return;
    const password = this.randomString();
    const payload = sjcl.encrypt(password, this.state.secret);
    this.setState({ loading: true, error: "" });
    const url = process.env.REACT_APP_BACKEND_URL
      ? `${process.env.REACT_APP_BACKEND_URL}/secret`
      : "/secret";
    fetch(url, {
      method: "POST",
      body: JSON.stringify({
        secret: payload,
        expiration: parseInt(this.state.lifetime, 10)
      })
    })
      .then(r => {
        if (r.status !== 200) {
          r.json()
            .then(j => {
              this.setState({ loading: false, error: j.message });
            })
            .catch(err => {
              this.setState({
                loading: false,
                error: `Unable to store message in database, error: ${
                  r.statusText
                }`
              });
            });
          return;
        }
        r.json().then(j => {
          this.setState({
            password: password,
            key: j.message,
            loading: false,
            error: ""
          });
        });
      })
      .catch(err => {
        console.log(err);
        this.setState({
          loading: false,
          error: `Unable to store message in database, error: ${err}`
        });
      });
  }
  randomString() {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (var i = 0; i < 16; i++)
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
  }

  render() {
    return (
      <div>
        <CreateForm
          handleChange={this.handleChange}
          secret={this.state.secret}
          lifetime={this.state.lifetime}
          loading={this.state.loading}
          error={this.state.error}
        />
        {this.state.key && (
          <Redirect
            to={{
              pathname: "/result",
              state: { key: this.state.key, password: this.state.password }
            }}
          />
        )}
      </div>
    );
  }
}
