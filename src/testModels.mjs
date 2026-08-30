import dotenv from "dotenv";
import OpenAI from "openai";
dotenv.config();

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const models = ["groq/compound", "groq/compound-mini", "allam-2-7b", "openai/gpt-oss-20b"];

for (const model of models) {
  try {
    const r = await groq.chat.completions.create({
      model,
      messages: [{ role: "user", content: 'Return ONLY this JSON: {"status":"ok"}' }],
      max_tokens: 30,
    });
    const content = r.choices?.[0]?.message?.content || "";
    console.log(`\n✅ ${model}: "${content.slice(0,100)}"`);
  } catch (e) {
    console.error(`\n❌ ${model}: ${e.message}`);
  }
}
