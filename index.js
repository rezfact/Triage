import { startTriage } from './src/app.js';

startTriage().catch((error) => {
  console.error(error);
  process.exit(1);
});
