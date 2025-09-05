export const testSecrets = {
  simple: {
    message: 'This is a test secret message',
    expiration: 3600,
    one_time: true,
  },
};

export const testFiles = {
  textFile: {
    name: 'test.txt',
    content: 'This is a test file content',
    type: 'text/plain',
  },
  jsonFile: {
    name: 'data.json',
    content: '{"key": "value", "number": 42, "array": [1, 2, 3]}',
    type: 'application/json',
  },
  binaryFile: {
    name: 'test.png',
    // Small PNG data (1x1 transparent pixel)
    content: new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
      0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 11, 73, 68, 65, 84,
      120, 218, 99, 248, 15, 0, 0, 1, 0, 1, 0, 24, 221, 142, 175, 0, 0, 0, 0,
      73, 69, 78, 68, 174, 66, 96, 130,
    ]),
    type: 'image/png',
  },
};

export const mockResponses = {
  secretCreated: {
    message: 'secret-id-12345',
    key: 'encryption-key-67890',
  },
  fileUploaded: {
    message: 'file-id-54321',
    key: 'encryption-key-09876',
  },
  secretRetrieved: {
    message: 'Encrypted secret data here',
  },
  fileRetrieved: {
    message: 'Encrypted file data here',
    filename: 'test.txt',
  },
  secretNotFound: {
    message: 'Secret not found',
  },
  secretExpired: {
    message: 'Secret has expired',
  },
};

export const testUrls = {
  home: '/',
  createSecret: '/#/create',
  uploadFile: '/#/upload',
  viewSecret: (id: string, key: string) => `/#/secret/${id}/${key}`,
  viewFile: (id: string, key: string) => `/#/file/${id}/${key}`,
};

// Common test data generators
export function generateRandomSecret(length: number = 100): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function generateTestFile(
  name: string,
  size: number,
  type: string = 'text/plain',
): File {
  const content = generateRandomSecret(size);
  return new File([content], name, { type });
}

export function createMockSecretUrl(secretId: string, key: string): string {
  return `${testUrls.viewSecret(secretId, key)}`;
}

export function createMockFileUrl(fileId: string, key: string): string {
  return `${testUrls.viewFile(fileId, key)}`;
}
