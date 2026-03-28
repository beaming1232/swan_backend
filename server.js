import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenerativeAI } from '@google/generative-ai';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

import { SYSTEM_PROMPT } from "./prompt.js";
import User from "./models/User.js";

dotenv.config();

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/firgen')
  .then(() => console.log("✓ MongoDB connected successfully"))
  .catch((err) => console.error("✗ MongoDB connection error:", err.message));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here_change_in_production';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

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
  console.log("Health check requested");
  
  res.json({ status: "ok", message: "server is running" });
});

// --- User Registration ---
app.post("/register", async (req, res) => {
  try {
    console.log("Registration request body:", req.body);
    const { name, email, password, category, phone, address, policeStationId, badgeNumber } = req.body;

    // Validate required fields
    if (!name || !email || !password || !category) {
      return res.status(400).json({ error: "Name, email, password, and category are required" });
    }

    // Validate category
    if (!['PoliceMa', 'SimpleUser'].includes(category)) {
      return res.status(400).json({ error: "Category must be either 'PoliceMa' or 'SimpleUser'" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    // Create new user
    const user = new User({
      name,
      email,
      password,
      category,
      phone: phone || '',
      address: address || '',
      policeStationId: category === 'PoliceMa' ? policeStationId || '' : '',
      badgeNumber: category === 'PoliceMa' ? badgeNumber || '' : '',
    });

    await user.save();

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: "User registered successfully",
      user: user.toJSON(),
      token,
    });
  } catch (error) {
    console.error("Registration error:", error.message);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// --- User Login ---
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Compare password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: "Login successful",
      user: user.toJSON(),
      token,
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
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
    // GENERATE AI REPLY
    // ---------------------------------------------------------
    const result = await model.generateContent(fullPrompt);
    const aiReply = result.response.text().trim();

    // ---------------------------------------------------------
    // SAVE TO SESSION HISTORY
    // ---------------------------------------------------------
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: aiReply });

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

// --- Generate FIR in HTML format ---
app.post("/fir", (req, res) => {
  const {
    policeStation = "[Police Station Name]",
    district = "[District]",
    state = "[State]",
    firNo = "[FIR Number]",
    firDateTime = "[Date Time]",
    occurrenceDateTime = "[Occurrence Date Time]",
    placeOfOccurrence = "[Place]",
    complainantName = "[Complainant Name]",
    complainantFatherName = "[Father's Name]",
    complainantAddress = "[Address]",
    complainantPhone = "[Phone]",
    accusedName = "[Accused Name]",
    accusedDescription = "[Description]",
    incidentDescription = "[Incident Description]",
    lawSections = "[IPC/BNS Sections]"
  } = req.body;

  const firHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>First Information Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { text-align: center; font-weight: bold; font-size: 18px; }
        .section { margin-bottom: 20px; }
        .label { font-weight: bold; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #000; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <div class="header">FIRST INFORMATION REPORT</div>
    
    <div class="section">
        <p><span class="label">Police Station:</span> ${policeStation}</p>
        <p><span class="label">District:</span> ${district}</p>
        <p><span class="label">State:</span> ${state}</p>
    </div>
    
    <div class="section">
        <p><span class="label">FIR No:</span> ${firNo}</p>
        <p><span class="label">Date and Time of FIR:</span> ${firDateTime}</p>
        <p><span class="label">Date and Time of Occurrence:</span> ${occurrenceDateTime}</p>
        <p><span class="label">Place of Occurrence:</span> ${placeOfOccurrence}</p>
    </div>
    
    <div class="section">
        <p class="label">Complainant's Details:</p>
        <table>
            <tr><th>Name</th><td>${complainantName}</td></tr>
            <tr><th>Father's Name</th><td>${complainantFatherName}</td></tr>
            <tr><th>Address</th><td>${complainantAddress}</td></tr>
            <tr><th>Phone</th><td>${complainantPhone}</td></tr>
        </table>
    </div>
    
    <div class="section">
        <p class="label">Details of Accused (if known):</p>
        <table>
            <tr><th>Name</th><td>${accusedName}</td></tr>
            <tr><th>Description</th><td>${accusedDescription}</td></tr>
        </table>
    </div>
    
    <div class="section">
        <p class="label">Details of Incident:</p>
        <p>${incidentDescription}</p>
    </div>
    
    <div class="section">
        <p class="label">Sections of Law:</p>
        <p>${lawSections}</p>
    </div>
    
    <div class="section">
        <p>Signature of Complainant: ____________________</p>
        <p>Date: ____________________</p>
    </div>
    
    <div class="section">
        <p>Investigating Officer: ____________________</p>
        <p>Signature: ____________________</p>
        <p>Date: ____________________</p>
    </div>
</body>
</html>
  `;
  res.setHeader('Content-Type', 'text/html');
  res.send(firHtml);
});


app.listen(PORT, () => {
  console.log(`Succesfully connect to model`);
  console.log(`Server running on http://localhost:${PORT}`);
});