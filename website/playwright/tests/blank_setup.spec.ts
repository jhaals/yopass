import { test, expect } from '@playwright/test';
import globalSetup from './browser/globalSetup';
// import globalTeardown from './browser/globalTeardown';
import path from 'path';
const fs = require('fs');
let jsonObject: any;
const storageStateFileName = 'storage_state.json';
const storageStateFilePath = process.cwd() + path.sep + storageStateFileName;

globalSetup();

test.use({ storageState: storageStateFilePath });

test('blank_setup', async ({ page }) => {
  await page.goto('http://localhost:3000/');
  await page.waitForLoadState('networkidle');
  const description = page.locator('[data-playwright=blankPageDescription]');
  await expect(description).toHaveText('This page intentionally left blank.');
});
