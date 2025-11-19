// src/lib/openai.mjs
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config(); // .env 読み込み

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
