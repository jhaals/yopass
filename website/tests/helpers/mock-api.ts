import { Page } from '@playwright/test';

export interface MockSecretResponse {
  message: string;
  key?: string;
  one_time?: boolean;
  expiration?: number;
}

export interface MockFileResponse {
  message: string;
  key?: string;
  one_time?: boolean;
  expiration?: number;
}

export class MockAPI {
  private capturedRequests: Array<{
    url: string;
    method: string;
    payload: unknown;
  }> = [];

  constructor(private page: Page) {}

  async mockCreateSecret(response: MockSecretResponse, status: number = 200) {
    await this.page.route('**/secret', async route => {
      const headers = {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
      };

      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 200,
          headers,
          body: '',
        });
        return;
      }

      // Capture the request payload for validation
      if (route.request().method() === 'POST') {
        try {
          const payload = JSON.parse(route.request().postData() || '{}');
          this.capturedRequests.push({
            url: route.request().url(),
            method: route.request().method(),
            payload,
          });
        } catch {
          // Handle non-JSON payloads
        }
      }

      await route.fulfill({
        status,
        headers,
        json: response,
      });
    });
  }

  async mockUploadFile(response: MockFileResponse, status: number = 200) {
    await this.page.route('**/file', async route => {
      const headers = {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
      };

      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 200,
          headers,
          body: '',
        });
        return;
      }

      // Capture the request payload for validation
      if (route.request().method() === 'POST') {
        try {
          const payload = JSON.parse(route.request().postData() || '{}');
          this.capturedRequests.push({
            url: route.request().url(),
            method: route.request().method(),
            payload,
          });
        } catch {
          // Handle non-JSON payloads
        }
      }

      await route.fulfill({
        status,
        headers,
        json: response,
      });
    });
  }

  async mockGetSecret(
    secretId: string,
    response: Record<string, unknown>,
    status: number = 200,
  ) {
    await this.page.route(`**/secret/${secretId}`, async route => {
      const headers = {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
      };

      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 200,
          headers,
          body: '',
        });
        return;
      }

      await route.fulfill({
        status,
        headers,
        json: response,
      });
    });
  }

  async mockGetFile(
    fileId: string,
    response: Record<string, unknown>,
    status: number = 200,
  ) {
    await this.page.route(`**/file/${fileId}`, async route => {
      const headers = {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
      };

      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 200,
          headers,
          body: '',
        });
        return;
      }

      await route.fulfill({
        status,
        headers,
        json: response,
      });
    });
  }

  async mockDeleteSecret(secretId: string, status: number = 200) {
    await this.page.route(`**/secret/${secretId}`, async route => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({
          status,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'access-control-allow-headers': 'Content-Type',
          },
          json: { message: 'Secret deleted' },
        });
      } else {
        await route.continue();
      }
    });
  }

  async mockConfigEndpoint(config?: {
    DISABLE_UPLOAD?: boolean;
    DISABLE_FEATURES?: boolean;
    PREFETCH_SECRET?: boolean;
    NO_LANGUAGE_SWITCHER?: boolean;
    FORCE_ONETIME_SECRETS?: boolean;
  }) {
    const defaultConfig = {
      DISABLE_UPLOAD: false,
      DISABLE_FEATURES: false,
      PREFETCH_SECRET: true,
      NO_LANGUAGE_SWITCHER: false,
      FORCE_ONETIME_SECRETS: false,
      ...config,
    };

    await this.page.route('**/config', async route => {
      const headers = {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
      };

      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 200,
          headers,
          body: '',
        });
        return;
      }

      await route.fulfill({
        status: 200,
        headers,
        json: defaultConfig,
      });
    });
  }

  async clearAllMocks() {
    await this.page.unrouteAll();
    this.capturedRequests = [];
  }

  getLastRequest(
    url?: string,
  ): { url: string; method: string; payload: unknown } | undefined {
    if (url) {
      // Find the last request matching the URL pattern
      for (let i = this.capturedRequests.length - 1; i >= 0; i--) {
        if (this.capturedRequests[i].url.includes(url)) {
          return this.capturedRequests[i];
        }
      }
      return undefined;
    }
    return this.capturedRequests[this.capturedRequests.length - 1];
  }

  getAllRequests(): Array<{ url: string; method: string; payload: unknown }> {
    return [...this.capturedRequests];
  }

  getRequestsByUrl(
    url: string,
  ): Array<{ url: string; method: string; payload: unknown }> {
    return this.capturedRequests.filter(req => req.url.includes(url));
  }
}
