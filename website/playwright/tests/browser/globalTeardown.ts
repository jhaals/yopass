import { unlink } from 'fs';

async function globalTeardown() {
  console.log('Global teardown....');
  unlink('cookies.json', (err) => {
    if (err) throw err;
    console.log('Deleted cookies.json file.');
  });
  unlink('storage_state.json', (err) => {
    if (err) throw err;
    console.log('Deleted storage_state.json file.');
  });
}

export default globalTeardown;
