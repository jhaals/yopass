import { test, expect } from '@playwright/test';
import path from 'path';
import {
  BLANK_PAGE_DESCRIPTION,
  STORAGE_STATE_FILE_NAME,
  STORAGE_STATE_FILE_PATH,
  ONETIME_TEST_USER_EMAIL,
} from './browser/constants';

const fs = require('fs');
let jsonObject: any;

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

    console.log('RSS: process.cwd():', process.cwd());
    console.log('RSS: __dirname:', __dirname);
    console.log('RSS: path.dirname(__filename):', path.dirname(__filename));
    fs.readdirSync(process.cwd()).forEach((file: any) => {
      var fileSizeInBytes = fs.statSync(file).size;
      if (file === STORAGE_STATE_FILE_NAME)
        console.log('RSS: File ', file, ' has ', fileSizeInBytes, ' bytes.');
    });

    // https://nodejs.org/en/knowledge/file-system/how-to-read-files-in-nodejs/
    // https://stackoverflow.com/a/10011174
    fs.readFile(STORAGE_STATE_FILE_PATH, 'utf8', function (err, data) {
      if (err) {
        return console.log(err);
      }
      jsonObject = JSON.parse(data);
      console.log('RSS: Cookies:', jsonObject['cookies'][0].name);
      console.log('RSS: Cookies:', jsonObject['cookies'][0].expires);
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

  test('create secret', async ({ page }) => {
    await page.goto('http://localhost:3000/#/create');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/create_secret.png' });

    const userEmailText = page.locator('data-test-id=userEmail');
    await expect(userEmailText).toHaveText(ONETIME_TEST_USER_EMAIL);

    await page.screenshot({ path: 'tests/output/create_secret.png' });
  });

  test('read secret', async ({ page }) => {
    await page.goto('http://localhost:3000/#/');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/read_secret.png' });
  });

  test('upload file', async ({ page }) => {
    await page.goto('http://localhost:3000/#/upload');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/upload_file.png' });

    const userEmailText = page.locator('data-test-id=userEmail');
    await expect(userEmailText).toHaveText(ONETIME_TEST_USER_EMAIL);

    await page.screenshot({ path: 'tests/output/upload_file.png' });
  });

  test('download file', async ({ page }) => {
    await page.goto('http://localhost:3000/#/');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/output/download_file.png' });
  });
});
