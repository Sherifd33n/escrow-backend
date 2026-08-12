import OpenAI from "openai";
import "dotenv/config";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

async function testGroq() {
  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: "Say hello and confirm that Groq is working.",
        },
      ],
    });

    console.log("Groq response:");
    console.log(response.choices[0].message.content);
  } catch (error) {
    console.error("Groq error:", error);
  }
}

testGroq();