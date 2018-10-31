import React from "react";
import ReactDOM from "react-dom";
import App from "./App";
import Puppeteer from "puppeteer";

it("renders without crashing", () => {
  const div = document.createElement("div");
  ReactDOM.render(<App />, div);
  ReactDOM.unmountComponentAtNode(div);
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// This requires the dev server to be running on port 3000
it("E2E encryption/decryption", async () => {
  const secretMessage = "Hello World!";
  const browser = await Puppeteer.launch();
  const page = await browser.newPage();

  await page.goto("http://localhost:3000");
  await page.keyboard.type(secretMessage);
  await page.click("button");
  await sleep(1000); // wait while uploading
  const url = await page.$eval("#full-i", el => el.value);

  await page.goto(url);
  await sleep(250); // decrypting
  const result = await page.$eval("pre", el => el.innerText);
  expect(result).toBe(secretMessage);

  // Page should not be visible twice
  await page.reload({ waitUntil: "networkidle0" });
  expect(await page.$eval("h2", el => el.innerText)).toBe(
    "Secret does not exist"
  );

  await browser.close();
});
