// src/lib/notion/applyTemplate.mjs

export function applyTemplate(template, info, customMessage = "") {
    return template
      .replace(/{{company_name}}/g, info.company_name)
      .replace(/{{address}}/g, info.address)
      .replace(/{{tel}}/g, info.tel)
      .replace(/{{email}}/g, info.email)
      .replace(/{{sender}}/g, info.sender)
      .replace(/{{department}}/g, info.department)
      .replace(/{{custom_message}}/g, customMessage);
  }
  