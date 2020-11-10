import React from "react";
import ReactDOM from "react-dom";
import { Suspense } from "react";
import App from "./App";
import "./i18n";

ReactDOM.render(
  <Suspense fallback={<div>Loading...</div>}>
    <App />
  </Suspense>,
  document.getElementById("root")
);
