const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const { SYSTEM_PROMPT } = require("./prompt");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL;

if (!MODEL) {
  console.error(" MODEL_API_KEY is missing! Add it to your .env file");
  process.exit(1);
}

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(MODEL);
const model = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview", // or "gemini-1.5-flash" for faster/cheaper
});

const sessions = new Map();

// Helper: get or create session
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, []);
  }
  return sessions.get(sessionId);
}

// --- Health check ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "IPC Chatbot is running 🟢" });
});


app.post("/session", (req, res) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, []);
  res.json({ sessionId });
});

// --- Main chat endpoint ---
// Body: { sessionId: string, message: string }
// If no sessionId is sent, a new one is created automatically
app.post("/chat", async (req, res) => {
  try {
    let { sessionId, message } = req.body;

    // Validate message
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "Message is required" });
    }

    // Auto-create session if not provided
    if (!sessionId) {
      sessionId = uuidv4();
      sessions.set(sessionId, []);
    }

    const history = getSession(sessionId);

    // ---------------------------------------------------------
    // BUILD THE PROMPT THAT GOES TO GEMINI
    // Structure:
    //   [SYSTEM PROMPT]
    //   + [Previous chat history formatted as conversation]
    //   + [Current user message]
    // ---------------------------------------------------------
    let fullPrompt = SYSTEM_PROMPT + "\n\n";

    // Add previous chat history
    if (history.length > 0) {
      fullPrompt += "--- PREVIOUS CONVERSATION ---\n";
      history.forEach((msg) => {
        const role = msg.role === "user" ? "User" : "Assistant";
        fullPrompt += `${role}: ${msg.content}\n\n`;
      });
      fullPrompt += "--- END OF PREVIOUS CONVERSATION ---\n\n";
    }

    // Add current user message
    fullPrompt += `User: ${message}\n\nAssistant:`;

    // ---------------------------------------------------------
    // SEND TO GEMINI
    // ---------------------------------------------------------
    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const aiReply = response.text();

    // ---------------------------------------------------------
    // SAVE TO SESSION HISTORY
    // ---------------------------------------------------------
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: aiReply });

    // Keep history to last 20 messages to avoid token limits
    // (10 user + 10 assistant messages)
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    // ---------------------------------------------------------
    // RESPOND
    // ---------------------------------------------------------
    res.json({
      sessionId,
      reply: aiReply,
      historyLength: history.length,
    });
  } catch (error) {
    console.error(" Error in /chat:", error.message);

    // Handle specific Gemini API errors
    if (error.message?.includes("API key")) {
      return res.status(401).json({ error: "Invalid Gemini API key" });
    }
    if (error.message?.includes("quota")) {
      return res.status(429).json({ error: "API quota exceeded. Try again later." });
    }

    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// --- Get current chat history ---
app.get("/chat/history/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const history = sessions.get(sessionId);

  if (!history) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({ sessionId, history });
});

// --- Clear session history ---
app.delete("/chat/history/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: "Session not found" });
  }

  sessions.set(sessionId, []);
  res.json({ message: "History cleared", sessionId });
});


app.listen(PORT, () => {
  console.log(`\n IPC Chatbot Server running on http://localhost:${PORT}`);
});