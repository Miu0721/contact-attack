// src/lib/notion/applyTemplate.mjs
export function applyTemplate(template, info, customMessage = '') {
  const safeTemplate = template || '';
  const replacements = {
    company_name: info.company_name || '',
    address: info.address || '',
    tel: info.tel || '',
    email: info.email || '',
    sender: info.sender || '',
    department: info.department || '',
    custom_message: customMessage || '',
  };

  return Object.entries(replacements).reduce(
    (text, [key, value]) => text.replace(new RegExp(`{{${key}}}`, 'g'), value),
    safeTemplate
  );
}
