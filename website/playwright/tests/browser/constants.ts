import path from 'path';

export const COOKIES_FILE_NAME = 'cookies.json';
export const COOKIES_FILE_PATH = process.cwd() + path.sep + COOKIES_FILE_NAME;
export const STORAGE_STATE_FILE_NAME = 'storage_state.json';
export const STORAGE_STATE_FILE_PATH =
  process.cwd() + path.sep + STORAGE_STATE_FILE_NAME;
export const ONETIME_TEST_USER_EMAIL = 'onetime.testuser@internal.testuser';
export const BLANK_PAGE_DESCRIPTION = 'This page intentionally left blank.';
export const LOREM_IPSUM_TEXT =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
export const DATE_NOW_TEXT = Date.now().toString();
