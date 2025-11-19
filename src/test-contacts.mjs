import { fetchContacts, updateContactRowValues, updateContactRowColor } from './lib/google/contactsRepo.mjs';

(async () => {
  const contacts = await fetchContacts();
  console.log('contacts:', contacts);

  if (contacts.length === 0) {
    console.log('No contacts rows found');
    return;
  }

  const first = contacts[0];

  const now = new Date().toISOString();

  // 値更新テスト
  await updateContactRowValues(first, {
    status: 'Success',
    lastRunAt: now,
    lastResult: 'sent',
    lastErrorMsg: '',
    runCount: (first.runCount || 0) + 1,
  });

  // 色変更テスト
  await updateContactRowColor(first.rowIndex, 'Success');

  console.log('✅ 1行目の更新 & 色付けテスト完了');
})();
