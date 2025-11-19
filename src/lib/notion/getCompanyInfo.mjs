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

  return {
    company_name: props["Company Name"]?.title[0]?.plain_text ?? "",
    address: props["Address"]?.rich_text[0]?.plain_text ?? "",
    tel: props["TEL"]?.rich_text[0]?.plain_text ?? "",
    email: props["Email"]?.email ?? "",
    sender: props["Sender"]?.rich_text[0]?.plain_text ?? "",
    department: props["Department"]?.rich_text[0]?.plain_text ?? "",
    template: props["Template"]?.rich_text?.map(t => t.plain_text).join("") ?? "",
  };
}
