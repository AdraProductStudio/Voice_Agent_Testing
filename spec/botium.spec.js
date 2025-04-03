const express = require("express");
const http = require("http");
const fs = require("fs");
const { BotDriver } = require("botium-core");
const OpenAI = require("openai");
const cors = require("cors");
const compression = require("compression");
require("dotenv").config();

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = 5000;
const userSessions = {};
const botiumSessionTimeout = 6 * 60 * 1000;
const requestTimeout = 6 * 60 * 1000;
const botiumConfigPath = "botium.json";

app.use(compression({ filter: (req, res) => req.path !== "/start-botium-test" }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json());

async function startBotiumSession(userId) {
  try {
    console.log("\n\n\-----------------------new request-------------------------\n\n")
    console.log(`🔄 Starting Botium session for ${userId}...`);
    const botiumDriver = new BotDriver();
    const bot = await botiumDriver.Build();
    await bot.Start();
    userSessions[userId] = { bot, botiumDriver, timeout: setTimeout(() => stopBotiumSession(userId), botiumSessionTimeout) };
    console.log(`✅ Botium session started for ${userId}`);
    return bot;
  } catch (error) {
    console.error(`❌ Error starting Botium for ${userId}:`, error);
    throw error;
  }
}

async function stopBotiumSession(userId) {
  const session = userSessions[userId];
  if (!session) return;
  try {
    console.log(`🔴 Stopping Botium session for user ${userId}...`);
    await session.bot.Stop();
    await session.bot.Clean();
    delete userSessions[userId];
    console.log(`✅ Session for user ${userId} stopped.`);
  } catch (error) {
    console.error(`❌ Error stopping Botium session for user ${userId}:`, error);
  }
}

async function generateDynamicInput(botResponseText, systemPrompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Respond to: ${botResponseText}` },
      ],
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("❌ OpenAI API Error:", error);
    return "I didn't understand that.";
  }
}

app.post("/start-botium-test", async (req, res) => {
  const { userId, inboundNumber, systemPrompt } = req.body;
  if (!userId || !inboundNumber || !systemPrompt) {
    return res.status(400).json({ error: "Missing required parameters." });
  }

  if (userSessions[userId]) {
    console.log(`🛑 Stopping existing session for user ${userId}...`);
    await stopBotiumSession(userId);
  }

  let botiumConfig = {};
  if (fs.existsSync(botiumConfigPath)) {
    botiumConfig = JSON.parse(fs.readFileSync(botiumConfigPath, "utf8"));
  }

  if (!botiumConfig.botium) botiumConfig.botium = {};
  if (!botiumConfig.botium.Capabilities) botiumConfig.botium.Capabilities = {};

  botiumConfig.botium.Capabilities.PROJECTNAME = process.env.PROJECTNAME;
  botiumConfig.botium.Capabilities.CONTAINERMODE = process.env.CONTAINERMODE;
  botiumConfig.botium.Capabilities.TWILIO_IVR_ACCOUNT_SID = process.env.TWILIO_IVR_ACCOUNT_SID;
  botiumConfig.botium.Capabilities.TWILIO_IVR_AUTH_TOKEN = process.env.TWILIO_IVR_AUTH_TOKEN;
  botiumConfig.botium.Capabilities.TWILIO_IVR_FROM = process.env.TWILIO_IVR_FROM;
  botiumConfig.botium.Capabilities.TWILIO_IVR_INBOUNDPORT = process.env.TWILIO_IVR_INBOUNDPORT;
  botiumConfig.botium.Capabilities.TWILIO_IVR_PUBLICURL = process.env.TWILIO_IVR_PUBLICURL;
  botiumConfig.botium.Capabilities.TWILIO_CALL_DIRECTION = process.env.TWILIO_CALL_DIRECTION;
  botiumConfig.botium.Capabilities.TWILIO_IVR_STT = process.env.TWILIO_IVR_STT;
  botiumConfig.botium.Capabilities.TWILIO_IVR_TTS = process.env.TWILIO_IVR_TTS;
  botiumConfig.botium.Capabilities.DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  botiumConfig.botium.Capabilities.DEEPGRAM_STT_MODEL = process.env.DEEPGRAM_STT_MODEL;
  botiumConfig.botium.Capabilities.DEEPGRAM_TTS_VOICE = process.env.DEEPGRAM_TTS_VOICE;
  botiumConfig.botium.Capabilities.TWILIO_IVR_STATUS_CALLBACK = process.env.TWILIO_IVR_STATUS_CALLBACK;
  botiumConfig.botium.Capabilities.BOTIUM_INBOUND_PROXY_START = process.env.BOTIUM_INBOUND_PROXY_START;
  botiumConfig.botium.Capabilities.CLEANUPTEMPDIR = process.env.CLEANUPTEMPDIR;
  botiumConfig.botium.Capabilities.TWILIO_IVR_RECORD = process.env.TWILIO_IVR_RECORD;
  botiumConfig.botium.Capabilities.WAITFORBOTTIMEOUT = process.env.WAITFORBOTTIMEOUT;
  botiumConfig.botium.Capabilities.SCRIPTING_ENABLE_MEMORY = process.env.SCRIPTING_ENABLE_MEMORY;
  botiumConfig.botium.Capabilities.DEBUG = process.env.DEBUG;
  botiumConfig.botium.Capabilities.SIMULATEDPORT = process.env.SIMULATEDPORT;
  botiumConfig.botium.Capabilities.TWILIO_IVR_TO = inboundNumber;
  fs.writeFileSync(botiumConfigPath, JSON.stringify(botiumConfig, null, 2));


  // Set response headers for Server-Sent Events
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  req.socket.setKeepAlive(true);
  res.flush();

  // Timeout duration in milliseconds (e.g., 10 minutes)
  const timeoutId = setTimeout(() => {
    console.log(`❌ Request timed out for user ${userId}.`);
    res.write(`data: ${JSON.stringify({ error_code: 201, message: "Request timed out." })}\n\n`);
    res.end();
  }, requestTimeout);

  try {
    const bot = await startBotiumSession(userId);
    let userInput = "Hello";

    function sendSSE(data) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.flush();
    }

    function logConversation(type, message) {
      const timestamp = new Date().toISOString();
      const logEntry = { conversation_by: type, message, conversation_time: timestamp };
      fs.appendFileSync("conversation_log.txt", JSON.stringify(logEntry) + "\n");
      sendSSE({ error_code: 0, data: logEntry, message: "Conversation log" });
    }

    while (true) {
      console.log(`🗣️ User: ${userInput}`);
      await bot.UserSaysText(userInput);
      logConversation("user", userInput);

      try {
        const botResponse = await bot.WaitBotSays();
        const botResponseText = botResponse.messageText.trim();
        logConversation("bot", botResponseText);

        console.log(`🤖 AI Voice Agent: ${botResponseText}`);
        if (/(bye|thank you!|feel free to ask|feel free to reach out)/i.test(botResponseText)) {
          sendSSE({ error_code: 201, message: "Ending conversation." });
          break;
        }
        userInput = await generateDynamicInput(botResponseText, systemPrompt);
      } catch (err) {
        console.error("Bot response error:", err);
        sendSSE({ error_code: 201, message: "Bot response error: " + err.message });
        break;
      }
    }

    await stopBotiumSession(userId);
    sendSSE({ error_code: 201, data: {}, message: "Test completed" });
    res.end();
  } catch (error) {
    console.error("Error running Botium test:", error);
    res.write(`data: ${JSON.stringify({ error_code: 201, data: {}, message: error.message })}\n\n`);
    res.end();
  } finally {
    // Clear the timeout if the request completes successfully
    clearTimeout(timeoutId);
  }
});

app.post("/stop-botium-test", async (req, res) => {
  const { userId } = req.body;
  if (!userId || !userSessions[userId]) {
    return res.status(400).json({ error: "No active Botium test for this user." });
  }
  try {
    await stopBotiumSession(userId);
    res.status(201).json({ error_code: 0, data: {}, message: `Botium test stopped for user ${userId}` });
  } catch (error) {
    console.error("Error stopping Botium test:", error);
    res.status(201).json({ error_code: 201, data: {}, error: error.message });
  }
});

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

server.on("error", (err) => {
  console.error("❌ Server error:", err);
});

process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT received. Shutting down gracefully...");

  try {
    console.log("🔴 Stopping all active sessions...");
    for (const userId of Object.keys(userSessions)) {
      await stopBotiumSession(userId);
    }
  } catch (error) {
    console.error("❌ Error while stopping sessions:", error);
  }

  console.log("🔴 Closing server...");
  server.close(() => {
    console.log("✅ Server shut down.");
    process.exit(0);
  });

  // Force exit if it takes too long
  setTimeout(() => {
    console.log("⚠️ Force shutting down...");
    process.exit(1);
  }, 5000);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Promise Rejection:", reason);
});