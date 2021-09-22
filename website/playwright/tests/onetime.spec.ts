import { test, expect } from '@playwright/test';
import path from 'path';
import {
  BLANK_PAGE_DESCRIPTION,
  STORAGE_STATE_FILE_NAME,
  STORAGE_STATE_FILE_PATH,
  ONETIME_TEST_USER_EMAIL,
  LOREM_IPSUM_TEXT,
} from './browser/constants';

const fs = require('fs');
let jsonObject: any;
let accessSecretFullLinkText: string;

test.describe.serial('onetime', () => {
  test.use({ storageState: STORAGE_STATE_FILE_PATH });

  test('check blank page', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/#/');
    // await page.waitForLoadState('networkidle');

    const description = page.locator('data-test-id=blankPageDescription');
    await expect(description).toHaveText(BLANK_PAGE_DESCRIPTION);

    const userButton = page.locator('data-test-id=userButton');
    await expect(userButton).toHaveText('Sign-Out');
  });

  test('reuse storage state', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/#/');
    // await page.waitForLoadState('networkidle');

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
    fs.readFile(
      STORAGE_STATE_FILE_PATH,
      'utf8',
      function (err: any, data: string) {
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
      },
    );

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

  test.beforeEach(async ({ page, baseURL }) => {
    await page.route(baseURL + '/#/secret', (route) => {
      route.fulfill({
        body: `{
          expiration: '0000',
          message: '75c3383d-a0d9-4296-8ca8-026cc2272271',
          one_time: true,
          access_token: '0000',
          }`,
      });
    });
    await page.goto(baseURL + '/#/');
  });

  test('create secret', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/#/create');
    // await page.waitForLoadState('networkidle');
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

    await page.fill('data-test-id=inputSecret', LOREM_IPSUM_TEXT);
    await page.click('data-test-id=encryptSecret');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/create_secret.png' });

    const allTableBody = await page.$$eval(
      'tbody .MuiTableRow-root',
      (items) => {
        return items.map((user) => {
          const secondColumnData = user.querySelector('td:nth-child(2)');
          const thirdColumnData = user.querySelector('td:nth-child(3)');
          return {
            secondColumnData: secondColumnData.textContent.trim(),
            thirdColumnData: thirdColumnData.textContent.trim(),
          };
        });
      },
    );

    console.dir(allTableBody);
    console.log(`The table has ${allTableBody.length} items....`);
    console.log('OneClickLink:', `${allTableBody.at(0).thirdColumnData}`);
    accessSecretFullLinkText = `${allTableBody.at(0).thirdColumnData}`;

    // TODO: Why below N-th Element Selector does not work on GitHub Action and Azure DevOps?
    // TODO: (っ ºДº)っ ︵ ⌨
    // const linkSelector = '.MuiTableBody-root > :nth-child(1) > :nth-child(3)';
    // const fullLinkLocator = page.locator(linkSelector);
    // accessSecretFullLinkText = (await fullLinkLocator.textContent()).toString();

    console.log('Access Secret Full Link:', accessSecretFullLinkText);

    // We will access the secret at this later without valid authentication state.
  });

  test('create mock secret', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/#/create');
    await page.waitForLoadState('networkidle');

    // Subscribe to 'request' and 'response' events.
    // https://playwright.dev/docs/network#network-events
    page.on('request', (request) =>
      console.log('>>', request.method(), request.url()),
    );
    page.on('response', (response) =>
      console.log('<<', response.status(), response.url()),
    );
  });

  test('upload file', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/#/upload');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/upload_file.png' });

    const userEmailText = page.locator('data-test-id=userEmail');
    await expect(userEmailText).toHaveText(ONETIME_TEST_USER_EMAIL);

    // TODO: Mock upload file.

    await page.screenshot({ path: 'tests/output/upload_file.png' });
  });
});

test.describe.serial('anonymous onetime', () => {
  test.use({ storageState: 'empty_storage_state.json' });

  test('anonymous check blank page', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/#/');

    const description = page.locator('data-test-id=blankPageDescription');
    await expect(description).toHaveText(BLANK_PAGE_DESCRIPTION);

    const userButton = page.locator('data-test-id=userButton');
    await expect(userButton).toHaveText('Sign-In');
  });

  test('anonymous read secret', async ({ page, baseURL }) => {
    console.log('Access Secret Full Link:', accessSecretFullLinkText);
    await page.goto(accessSecretFullLinkText);

    const secretText = await page.waitForSelector('data-test-id=secret');
    const secretTextContent = (await secretText.innerText()).toString();
    expect(secretTextContent).toContain(LOREM_IPSUM_TEXT);
    await page.screenshot({ path: 'tests/output/read_secret.png' });
  });
});
