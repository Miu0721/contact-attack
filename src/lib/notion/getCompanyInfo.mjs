// src/lib/notion/getCompanyInfo.mjs
import { Client } from '@notionhq/client';
import 'dotenv/config';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export async function getCompanyInfo() {
  const res = await notion.databases.query({
    database_id: process.env.NOTION_DB_ID,
    page_size: 1,
  });

  if (!res.results.length) {
    throw new Error("No records found in Notion DB");
  }

  const props = res.results[0].properties;
  const getRichText = (key) => props[key]?.rich_text?.map((t) => t.plain_text).join('') ?? '';
  const getTitle = (key) => props[key]?.title?.[0]?.plain_text ?? '';

  return {
    company_name: getTitle('Company Name'),
    address: getRichText('Address'),
    tel: getRichText('TEL'),
    email: props['Email']?.email ?? '',
    sender: getRichText('Sender'),
    department: getRichText('Department'),
    template: getRichText('Template'),
  };
}
