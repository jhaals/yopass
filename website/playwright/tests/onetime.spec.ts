import { test, expect } from '@playwright/test';
import path from 'path';
import { text } from 'stream/consumers';
import {
  BLANK_PAGE_DESCRIPTION,
  STORAGE_STATE_FILE_NAME,
  STORAGE_STATE_FILE_PATH,
  ONETIME_TEST_USER_EMAIL,
  LOREM_IPSUM_TEXT,
  DATE_NOW_TEXT,
} from './browser/constants';

const fs = require('fs');
let jsonObject: any;

// Subscribe to 'request' and 'response' events.
// https://playwright.dev/docs/network#network-events
// (async () => {
//   const browser = await chromium.launch();
//   const page = await browser.newPage();
//   page.on('request', (request) =>
//     console.log('>>', request.method(), request.url()),
//   );
//   page.on('response', (response) =>
//     console.log('<<', response.status(), response.url()),
//   );
//   await page.goto('https://playwright.dev/');
//   await browser.close();
// })();

test.use({ storageState: STORAGE_STATE_FILE_PATH });

test.describe.serial('onetime', () => {
  test('check blank page', async ({ page }) => {
    await page.goto('http://localhost:3000/#/');
    await page.waitForLoadState('networkidle');

    const description = page.locator('data-test-id=blankPageDescription');
    await expect(description).toHaveText(BLANK_PAGE_DESCRIPTION);

    const userButton = page.locator('data-test-id=userButton');
    await expect(userButton).toHaveText('Sign-Out');
  });

  test('reuse storage state', async ({ page }) => {
    await page.goto('http://localhost:3000/#/');
    await page.waitForLoadState('networkidle');

    console.log('Reuse Storage State: process.cwd():', process.cwd());
    console.log('Reuse Storage State: __dirname:', __dirname);
    console.log(
      'Reuse Storage State: path.dirname(__filename):',
      path.dirname(__filename),
    );
    fs.readdirSync(process.cwd()).forEach((file: any) => {
      var fileSizeInBytes = fs.statSync(file).size;
      if (file === STORAGE_STATE_FILE_NAME)
        console.log(
          'Reuse Storage State: File ',
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
        return console.log(err);
      }
      jsonObject = JSON.parse(data);
      console.log(
        'Reuse Storage State: Cookies:',
        jsonObject['cookies'][0].name,
      );
      console.log(
        'Reuse Storage State: Cookies:',
        jsonObject['cookies'][0].expires,
      );
    });

    const userButton = page.locator('data-test-id=userButton');
    await expect(userButton).toHaveText('Sign-Out');
    await userButton.screenshot({
      path: 'tests/output/reuse_storage_state_user_button.png',
    });

    const createButtonTitle = page.locator('data-test-id=createButton');
    await expect(createButtonTitle).toHaveText('Create');
    await createButtonTitle.screenshot({
      path: 'tests/output/reuse_storage_state_create_button.png',
    });

    const uploadButtonTitle = page.locator('data-test-id=uploadButton');
    await expect(uploadButtonTitle).toHaveText('Upload');
    await uploadButtonTitle.screenshot({
      path: 'tests/output/reuse_storage_state_upload_button.png',
    });

    await page.screenshot({ path: 'tests/output/reuse_storage_state.png' });
  });

  test.beforeEach(async ({ page }) => {
    await page.route('http://localhost:3000/#/secret', (route) => {
      route.fulfill({
        body: `{
          expiration: '0000',
          message: '75c3383d-a0d9-4296-8ca8-026cc2272271',
          one_time: true,
          access_token: '0000',
          }`,
      });
    });
    await page.goto('http://localhost:3000/#/');
  });

  test('create secret', async ({ page }) => {
    await page.goto('http://localhost:3000/#/create');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/create_secret.png' });

    const userEmailText = page.locator('data-test-id=userEmail');
    await expect(userEmailText).toHaveText(ONETIME_TEST_USER_EMAIL);

    // Subscribe to 'request' and 'response' events.
    // https://playwright.dev/docs/network#network-events
    page.on('request', (request) =>
      console.log('>>', request.method(), request.url()),
    );
    page.on('response', (response) =>
      console.log('<<', response.status(), response.url()),
    );

    const linkSelector = '.MuiTableBody-root > :nth-child(1) > :nth-child(3)';

    await page.fill('data-test-id=inputSecret', LOREM_IPSUM_TEXT);
    await page.click('data-test-id=encryptSecret');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/create_secret.png' });

    const fullLinkLocator = page.locator(linkSelector);
    const fullLinkText = (await fullLinkLocator.textContent()).toString();
    await page.goto(fullLinkText);

    const secretText = page.locator('data-test-id=secret');
    const secretTextContent = (await secretText.innerText()).toString();
    expect(secretTextContent).toContain(LOREM_IPSUM_TEXT);
    await page.screenshot({ path: 'tests/output/read_secret.png' });

    // TODO: Fix mock request from Cypress template.
    // await expect(fullLink).toContainText(
    //   'http://localhost:3000/#/s/75c3383d-a0d9-4296-8ca8-026cc2272271',
    // );

    // await fetch('http://localhost:3000/#/secret', {
    //   method: 'post',
    //   body: JSON.stringify(mockGetResponse),
    // });

    // cy.wait('@post').then(mockGetResponse);
    // cy.get(linkSelector)
    //   .invoke('text')
    //   .then((url) => {
    //     cy.visit(url);
    //     cy.get('pre').contains('hello world');
    //   });
  });

  // const mockGetResponse = async ({ intercept, page }) => {
  //   const body = JSON.parse(intercept.request.body);
  //   expect(body.expiration).toEqual(3600);
  //   expect(body.one_time).toEqual(true);
  //   // Intercept requests matching pattern, return given body
  //   await page.route(
  //     'localhost:3000/#/secret/75c3383d-a0d9-4296-8ca8-026cc2272271',
  //     (route) => {
  //       route.fulfill({
  //         body: `{
  //         expiration: '0000',
  //         message: '75c3383d-a0d9-4296-8ca8-026cc2272271',
  //         one_time: true,
  //         access_token: '0000',
  //         }`,
  //       });
  //     },
  //   );
  //   // Continue requests as GET.
  //   await page.route('**/*', (route) => route.continue({ method: 'GET' }));
  // };

  // test('read secret', async ({ page }) => {
  //   await page.goto('http://localhost:3000/#/');
  //   await page.waitForLoadState('networkidle');
  //   await page.screenshot({ path: 'tests/output/read_secret.png' });
  // });

  test('upload file', async ({ page }) => {
    await page.goto('http://localhost:3000/#/upload');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/upload_file.png' });

    const userEmailText = page.locator('data-test-id=userEmail');
    await expect(userEmailText).toHaveText(ONETIME_TEST_USER_EMAIL);

    // await page.setInputFiles('data-test-id=inputUpload', {
    //   name: 'uploadSecret.txt',
    //   mimeType: 'text/plain',
    //   buffer: Buffer.from(DATE_NOW_TEXT),
    // });
    // await page.click('data-test-id=uploadButton');

    await page.screenshot({ path: 'tests/output/upload_file.png' });
  });

  // test('download file', async ({ page }) => {
  //   await page.goto('http://localhost:3000/#/');
  //   await page.waitForLoadState('networkidle');
  //   await page.screenshot({ path: 'tests/output/download_file.png' });
  // });
});
