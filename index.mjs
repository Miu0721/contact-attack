// index.mjs
import express from 'express';
import fs from 'fs';
import { runFromSheetJob } from './src/run-from-sheet.mjs';

const app = express();
const port = process.env.PORT || 8080;

function ensureServiceAccountFile() {
  const saJson = process.env.SA_JSON;
  if (!saJson) {
    console.warn('SA_JSON が環境変数に設定されていません');
    return;
  }
  fs.writeFileSync('service-account.json', saJson, { encoding: 'utf8' });
  console.log('service-account.json を作成しました');
}

ensureServiceAccountFile();

app.get('/', (req, res) => {
  res.send('contact-attack-bot is running');
});

app.post('/run', async (req, res) => {
  console.log('🚀 /run が呼ばれました');
  try {
    await runFromSheetJob();
    res.status(200).json({ status: 'ok', message: 'ジョブ完了' });
  } catch (e) {
    console.error('ジョブ中にエラー', e);
    res.status(500).json({ status: 'error', message: e.message ?? 'unknown error' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
