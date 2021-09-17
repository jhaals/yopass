// import path from 'path';
import fs, { unlink } from 'fs';
// import path from 'path';

const cookiesFileName = 'cookies.json';
// const cookiesFilePath = process.cwd() + path.sep + cookiesFileName;
const storageStateFileName = 'storage_state.json';
// const storageStateFilePath = process.cwd() + path.sep + storageStateFileName;

async function globalTeardown() {
  console.log('Global teardown....');

  if (fs.existsSync(cookiesFileName)) {
    unlink(cookiesFileName, (err) => {
      if (err) throw err;
      console.log('Deleted', cookiesFileName, 'file.');
    });
  }

  if (fs.existsSync(storageStateFileName)) {
    unlink(storageStateFileName, (err) => {
      if (err) throw err;
      console.log('Deleted', storageStateFileName, 'file.');
    });
  }
}

export default globalTeardown;
