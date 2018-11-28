import * as Puppeteer from 'puppeteer';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import App from './App';

it('renders without crashing', () => {
  const div = document.createElement('div');
  ReactDOM.render(<App />, div);
  ReactDOM.unmountComponentAtNode(div);
});

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// This requires the dev server to be running on port 3000
it('passes in browser encryption/decryption', async () => {
  const secretMessage = 'Hello World!';
  const browser = await Puppeteer.launch();
  const page = await browser.newPage();

  await page.goto('http://localhost:3000');
  await page.keyboard.type(secretMessage);
  await page.click('button');
  // wait while uploading
  await sleep(1500);
  // @ts-ignore
  const url = await page.$eval('#full-i', el => el.value);

  await page.goto(url);
  await sleep(250); // decrypting
  // Ensure that secret can be viewed
  const result = await page.$eval('pre', el => el.innerHTML);
  expect(result).toBe(secretMessage);

  // Page should not be visible twice
  await page.reload({ waitUntil: 'networkidle0' });
  expect(await page.$eval('h2', el => el.innerHTML)).toBe(
    'Secret does not exist',
  );

  await browser.close();
}, 10000);
