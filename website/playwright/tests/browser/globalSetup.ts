import { chromium } from '@playwright/test';
import path from 'path';
const fs = require('fs');
let jsonObject: any;
const storageStateFileName = 'storage_state.json';
const storageStateFilePath = process.cwd() + path.sep + storageStateFileName;

async function globalSetup() {
  const browser = await chromium.launch();
  // const context = await browser.newContext();
  const page = await browser.newPage();

  await page.goto('http://localhost:3000/');
  await page.click('button#signInOrSignOutButton');
  await page.click('span:has-text("Logg inn med e-post")');

  await page.fill('#Email', process.env.ONETIME_TEST_USER_EMAIL);
  await page.fill('#Password', process.env.ONETIME_TEST_USER_PASSWORD);

  await page.click('button#LoginFormActionButton');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'tests/output/global_setup.png' });

  await page.context().storageState({ path: storageStateFilePath });

  console.log('GS: process.cwd():', process.cwd());
  console.log('GS: __dirname:', __dirname);
  console.log('GS: path.dirname(__filename):', path.dirname(__filename));
  fs.readdirSync(process.cwd()).forEach((file: any) => {
    var fileSizeInBytes = fs.statSync(file).size;
    if (file === storageStateFileName)
      console.log('GS: File ', file, ' has ', fileSizeInBytes, ' bytes.');
  });

  // https://nodejs.org/en/knowledge/file-system/how-to-read-files-in-nodejs/
  // https://stackoverflow.com/a/10011174
  fs.readFile(storageStateFilePath, 'utf8', function (err, data) {
    if (err) {
      return console.log('GS: ReadFile Error:', err);
    }
    jsonObject = JSON.parse(data);
    console.log('GS: Cookies:', jsonObject['cookies'][0].name);
    console.log('GS: Cookies:', jsonObject['cookies'][0].expires);
  });

  const cookies = await page.context().cookies();
  const cookieJson = JSON.stringify(cookies);
  fs.writeFileSync('cookies.json', cookieJson);

  await browser.close();
}

export default globalSetup;
