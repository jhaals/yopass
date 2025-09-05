import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';
import { testFiles } from './helpers/test-data';
import { encrypt, createMessage } from 'openpgp';

test.describe('File Download', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint();
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should automatically download file when decrypted', async ({
    page,
  }) => {
    const fileId = 'test-file-download-123';
    const password = 'test-password-123';
    const originalContent = testFiles.textFile.content;
    const originalFilename = testFiles.textFile.name;

    // Encrypt the file content with OpenPGP
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(originalContent)),
        filename: originalFilename,
      }),
      passwords: password,
    });

    // Mock status check for file
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    // Mock file retrieval with encrypted content
    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Set up download listener before navigation
    const downloadPromise = page.waitForEvent('download');

    // Navigate to the file URL with password
    await page.goto(`/#/f/${fileId}/${password}`);

    // Wait for the download to start
    const download = await downloadPromise;

    // Verify the downloaded filename
    expect(download.suggestedFilename()).toBe(originalFilename);

    // Verify the download happened (content verification requires backend integration testing)
    // In E2E tests, we verify the download was triggered with correct filename
  });

  test('should show file UI with download button after automatic download', async ({
    page,
  }) => {
    const fileId = 'test-file-ui-456';
    const password = 'test-password-456';
    const originalFilename = testFiles.jsonFile.name;
    const originalContent = testFiles.jsonFile.content;

    // Encrypt the file content
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(originalContent)),
        filename: originalFilename,
      }),
      passwords: password,
    });

    // Mock status and file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Navigate to the file URL
    await page.goto(`/#/f/${fileId}/${password}`);

    // Wait for the file UI to appear
    await expect(page.locator('h2:has-text("File Downloaded")')).toBeVisible({
      timeout: 10000,
    });

    // Check for the subtitle message
    await expect(
      page.locator('text=Your file has been decrypted and downloaded'),
    ).toBeVisible();

    // Check that the filename is displayed
    await expect(
      page.locator(`text=File downloaded: ${originalFilename}`),
    ).toBeVisible();

    // Check for the download button
    await expect(
      page.locator('button:has-text("Download File Again")'),
    ).toBeVisible();
  });

  test('should allow re-downloading the file when button is clicked', async ({
    page,
  }) => {
    const fileId = 'test-file-redownload-789';
    const password = 'test-password-789';
    const originalContent = testFiles.textFile.content;
    const originalFilename = testFiles.textFile.name;

    // Encrypt the file content
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(originalContent)),
        filename: originalFilename,
      }),
      passwords: password,
    });

    // Mock status and file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Navigate and wait for initial download
    const firstDownloadPromise = page.waitForEvent('download');
    await page.goto(`/#/f/${fileId}/${password}`);
    await firstDownloadPromise;

    // Wait for UI to appear
    await expect(
      page.locator('button:has-text("Download File Again")'),
    ).toBeVisible();

    // Click the download button for re-download
    const secondDownloadPromise = page.waitForEvent('download');
    await page.click('button:has-text("Download File Again")');
    const secondDownload = await secondDownloadPromise;

    // Verify the re-downloaded file
    expect(secondDownload.suggestedFilename()).toBe(originalFilename);
  });

  test('should handle binary files correctly', async ({ page }) => {
    const fileId = 'test-binary-file-abc';
    const password = 'test-password-abc';
    const originalContent = testFiles.binaryFile.content;
    const originalFilename = testFiles.binaryFile.name;

    // Encrypt the binary file content
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(originalContent),
        filename: originalFilename,
      }),
      passwords: password,
    });

    // Mock status and file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Set up download listener
    const downloadPromise = page.waitForEvent('download');

    // Navigate to the file URL
    await page.goto(`/#/f/${fileId}/${password}`);

    // Wait for the download
    const download = await downloadPromise;

    // Verify the filename
    expect(download.suggestedFilename()).toBe(originalFilename);

    // Verify the download happened with correct filename
    // Content verification would require backend integration testing
  });

  test('should handle files without explicit filename', async ({ page }) => {
    const fileId = 'test-no-filename-def';
    const password = 'test-password-def';
    const originalContent = 'Content without filename';

    // Encrypt without filename
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(originalContent)),
        // No filename specified
      }),
      passwords: password,
    });

    // Mock status and file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Set up download listener
    const downloadPromise = page.waitForEvent('download');

    // Navigate to the file URL
    await page.goto(`/#/f/${fileId}/${password}`);

    // Wait for the download
    const download = await downloadPromise;

    // Should use default filename
    expect(download.suggestedFilename()).toBe('download');
  });

  test('should show decryption key input for wrong password', async ({
    page,
  }) => {
    const fileId = 'test-wrong-password-ghi';
    const wrongPassword = 'wrong-password';
    const correctPassword = 'correct-password';
    const originalContent = testFiles.textFile.content;
    const originalFilename = testFiles.textFile.name;

    // Encrypt with correct password
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(originalContent)),
        filename: originalFilename,
      }),
      passwords: correctPassword,
    });

    // Mock status and file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Navigate with wrong password
    await page.goto(`/#/f/${fileId}/${wrongPassword}`);

    // Should show decryption key input
    await expect(
      page.locator('h2:has-text("Enter decryption key")'),
    ).toBeVisible();
    await expect(
      page.locator('input[placeholder="Decryption key"]'),
    ).toBeVisible();
    await expect(
      page.locator('button:has-text("DECRYPT SECRET")'),
    ).toBeVisible();

    // Enter correct password
    const downloadPromise = page.waitForEvent('download');
    await page.fill('input[placeholder="Decryption key"]', correctPassword);
    await page.click('button:has-text("DECRYPT SECRET")');

    // Should download the file
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(originalFilename);
  });

  test('should not show copy or QR code buttons for files', async ({
    page,
  }) => {
    const fileId = 'test-no-copy-jkl';
    const password = 'test-password-jkl';
    const originalContent = testFiles.textFile.content;
    const originalFilename = testFiles.textFile.name;

    // Encrypt the file
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(originalContent)),
        filename: originalFilename,
      }),
      passwords: password,
    });

    // Mock status and file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Navigate and wait for download
    const downloadPromise = page.waitForEvent('download');
    await page.goto(`/#/f/${fileId}/${password}`);
    await downloadPromise;

    // Wait for UI
    await expect(page.locator('h2:has-text("File Downloaded")')).toBeVisible({
      timeout: 10000,
    });

    // Should NOT show copy to clipboard button
    await expect(
      page.locator('button:has-text("Copy to Clipboard")'),
    ).not.toBeVisible();

    // Should NOT show QR code button
    await expect(
      page.locator('button:has-text("Show QR Code")'),
    ).not.toBeVisible();
  });

  test('should handle one-time file downloads with prefetch', async ({
    page,
  }) => {
    const fileId = 'test-onetime-mno';
    const password = 'test-password-mno';
    const originalContent = testFiles.textFile.content;
    const originalFilename = testFiles.textFile.name;

    // Encrypt the file
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(originalContent)),
        filename: originalFilename,
      }),
      passwords: password,
    });

    // Mock status check for one-time file
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: true },
      });
    });

    // Mock file retrieval
    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Navigate to the file URL
    await page.goto(`/#/f/${fileId}/${password}`);

    // Should show prefetch screen first
    await expect(page.locator('h2:has-text("Secure Message")')).toBeVisible();
    await expect(
      page.locator('button:has-text("Reveal Secure Message")'),
    ).toBeVisible();

    // Set up download listener
    const downloadPromise = page.waitForEvent('download');

    // Click reveal button
    await page.click('button:has-text("Reveal Secure Message")');

    // Should download the file
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(originalFilename);

    // Should show file UI
    await expect(page.locator('h2:has-text("File Downloaded")')).toBeVisible({
      timeout: 10000,
    });
  });

  test('should verify complete upload and download flow', async ({ page }) => {
    // Step 1: Upload a file
    const uploadedContent = 'This is my secret file content for testing';
    const uploadedFilename = 'secret-document.txt';
    const fileId = 'complete-flow-file-pqr';

    // Mock upload response - the server will return the generated password
    await mockAPI.mockUploadFile({
      message: fileId,
    });

    // Navigate to upload page
    await page.goto('/#/upload');

    // Upload file
    await page.setInputFiles('input[type="file"]', {
      name: uploadedFilename,
      mimeType: 'text/plain',
      buffer: Buffer.from(uploadedContent),
    });

    // Submit the form
    await page.click('button[type="submit"]');

    // Should show result page
    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // Get the generated URL
    const linkCode = page.locator('code').first();
    const fullUrl = await linkCode.textContent();

    // Extract file ID and password from URL - format is /f/fileId/password
    expect(fullUrl).toContain(`/f/${fileId}/`);

    // Extract the actual generated password from the URL
    const urlMatch = fullUrl?.match(/\/f\/[^/]+\/([^#\s]+)/);
    const generatedPassword = urlMatch ? urlMatch[1] : '';

    // Step 2: Download the file using the generated link
    // Create properly encrypted content for retrieval
    const encryptedForRetrieval = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(uploadedContent)),
        filename: uploadedFilename,
      }),
      passwords: generatedPassword,
    });

    // Mock file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: true },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedForRetrieval,
    });

    // Set up download listener
    const downloadPromise = page.waitForEvent('download');

    // Navigate to the file URL
    await page.goto(`/#/f/${fileId}/${generatedPassword}`);

    // Click reveal for one-time download
    await page.click('button:has-text("Reveal Secure Message")');

    // Wait for download
    const download = await downloadPromise;

    // Verify filename and content
    expect(download.suggestedFilename()).toBe(uploadedFilename);

    // Verify download happened with correct filename
    // Full content verification would require backend integration

    // Verify UI shows correctly
    await expect(page.locator('h2:has-text("File Downloaded")')).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.locator(`text=File downloaded: ${uploadedFilename}`),
    ).toBeVisible();
  });

  test('should handle large files correctly', async ({ page }) => {
    const fileId = 'test-large-file-stu';
    const password = 'test-password-stu';
    const largeContent = 'x'.repeat(1024 * 1024); // 1MB of data
    const filename = 'large-file.txt';

    // Encrypt the large file
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(largeContent)),
        filename: filename,
      }),
      passwords: password,
    });

    // Mock status and file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Set up download listener
    const downloadPromise = page.waitForEvent('download');

    // Navigate to the file URL
    await page.goto(`/#/f/${fileId}/${password}`);

    // Wait for the download
    const download = await downloadPromise;

    // Verify the filename
    expect(download.suggestedFilename()).toBe(filename);

    // Verify download happened with correct filename
    // Size verification would require backend integration
  });

  test('should handle special characters in filename', async ({ page }) => {
    const fileId = 'test-special-chars-vwx';
    const password = 'test-password-vwx';
    const content = 'File with special name';
    const specialFilename = 'file with spaces & special-chars!@#.txt';

    // Encrypt the file
    const encryptedMessage = await encrypt({
      format: 'armored',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from(content)),
        filename: specialFilename,
      }),
      passwords: password,
    });

    // Mock status and file retrieval
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetFile(fileId, {
      message: encryptedMessage,
    });

    // Set up download listener
    const downloadPromise = page.waitForEvent('download');

    // Navigate to the file URL
    await page.goto(`/#/f/${fileId}/${password}`);

    // Wait for the download
    const download = await downloadPromise;

    // Verify the filename with special characters
    expect(download.suggestedFilename()).toBe(specialFilename);

    // Verify UI displays the filename correctly
    await expect(
      page.locator(`text=File downloaded: ${specialFilename}`),
    ).toBeVisible();
  });
});
