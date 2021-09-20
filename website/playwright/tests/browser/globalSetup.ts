import { chromium } from '@playwright/test';
import path from 'path';
import {
  COOKIES_FILE_PATH,
  STORAGE_STATE_FILE_NAME,
  STORAGE_STATE_FILE_PATH,
} from './constants';

const fs = require('fs');
let jsonObject: any;

async function globalSetup() {
  console.log('GlobalSetup: Initializing....');

  const browser = await chromium.launch();
  // const context = await browser.newContext();
  const page = await browser.newPage();

  await page.goto('http://localhost:3000/#/');
  await page.click('data-test-id=userButton');
  await page.click('span:has-text("Logg inn med e-post")');

  await page.fill('#Email', process.env.ONETIME_TEST_USER_EMAIL);
  await page.fill('#Password', process.env.ONETIME_TEST_USER_PASSWORD);

  await page.click('button#LoginFormActionButton');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'tests/output/global_setup.png' });

  await page.context().storageState({ path: STORAGE_STATE_FILE_PATH });

  console.log('GlobalSetup: process.cwd():', process.cwd());
  console.log('GlobalSetup: __dirname:', __dirname);
  console.log(
    'GlobalSetup: path.dirname(__filename):',
    path.dirname(__filename),
  );
  fs.readdirSync(process.cwd()).forEach((file: any) => {
    var fileSizeInBytes = fs.statSync(file).size;
    if (file === STORAGE_STATE_FILE_NAME)
      console.log(
        'GlobalSetup: File ',
        file,
        ' has ',
        fileSizeInBytes,
        ' bytes.',
      );
  });

  // https://nodejs.org/en/knowledge/file-system/how-to-read-files-in-nodejs/
  // https://stackoverflow.com/a/10011174
  fs.readFile(STORAGE_STATE_FILE_PATH, 'utf8', function (err, data) {
    if (err) {
      return console.log('GlobalSetup: ReadFile Error:', err);
    }
    jsonObject = JSON.parse(data);
    console.log('GlobalSetup: Cookies:', jsonObject['cookies'][0].name);
    console.log('GlobalSetup: Cookies:', jsonObject['cookies'][0].expires);
  });

  const cookies = await page.context().cookies();
  const cookieJson = JSON.stringify(cookies);
  fs.writeFileSync(COOKIES_FILE_PATH, cookieJson);

  await browser.close();
}

export default globalSetup;
