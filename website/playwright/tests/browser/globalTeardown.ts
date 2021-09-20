// import path from 'path';
import fs, { unlink } from 'fs';
// import path from 'path';

const cookiesFileName = 'cookies.json';
// const cookiesFilePath = process.cwd() + path.sep + cookiesFileName;
const storageStateFileName = 'storage_state.json';
// const storageStateFilePath = process.cwd() + path.sep + storageStateFileName;

async function globalTeardown() {
  console.log('GlobalTeardown: Initializing....');

  if (fs.existsSync(cookiesFileName)) {
    unlink(cookiesFileName, (err) => {
      if (err) throw err;
    });
    console.log('GlobalTeardown: Deleted', cookiesFileName, 'file.');
  } else {
    console.log('GlobalTeardown: The', cookiesFileName, 'file not found.');
  }

  if (fs.existsSync(storageStateFileName)) {
    unlink(storageStateFileName, (err) => {
      if (err) throw err;
    });
    console.log('GlobalTeardown: Deleted', storageStateFileName, 'file.');
  } else {
    console.log('GlobalTeardown: The', storageStateFileName, 'file not found.');
  }
}

export default globalTeardown;
