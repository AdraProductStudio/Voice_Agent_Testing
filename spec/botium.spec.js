const express = require("express");
const http = require("http");
const fs = require("fs");
const { BotDriver } = require("botium-core");
const OpenAI = require("openai");
require("dotenv").config();
const socketIo = require("socket.io");
const cors = require("cors");
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const botiumConfigPath = "botium.json";

let botiumConfig = {};
if (fs.existsSync(botiumConfigPath)) {
  botiumConfig = JSON.parse(fs.readFileSync(botiumConfigPath, "utf8"));
}

if (!botiumConfig.botium) botiumConfig.botium = {};
if (!botiumConfig.botium.Capabilities) botiumConfig.botium.Capabilities = {};

botiumConfig.botium.Capabilities.PROJECTNAME = process.env.PROJECTNAME;
botiumConfig.botium.Capabilities.CONTAINERMODE = process.env.CONTAINERMODE;
botiumConfig.botium.Capabilities.TWILIO_IVR_ACCOUNT_SID =
  process.env.TWILIO_IVR_ACCOUNT_SID;
botiumConfig.botium.Capabilities.TWILIO_IVR_AUTH_TOKEN =
  process.env.TWILIO_IVR_AUTH_TOKEN;
botiumConfig.botium.Capabilities.TWILIO_IVR_FROM = process.env.TWILIO_IVR_FROM;
botiumConfig.botium.Capabilities.TWILIO_IVR_TO = process.env.TWILIO_IVR_TO;
botiumConfig.botium.Capabilities.TWILIO_IVR_INBOUNDPORT =
  process.env.TWILIO_IVR_INBOUNDPORT;
botiumConfig.botium.Capabilities.TWILIO_IVR_PUBLICURL =
  process.env.TWILIO_IVR_PUBLICURL;
botiumConfig.botium.Capabilities.TWILIO_CALL_DIRECTION =
  process.env.TWILIO_CALL_DIRECTION;
botiumConfig.botium.Capabilities.TWILIO_IVR_STT = process.env.TWILIO_IVR_STT;
botiumConfig.botium.Capabilities.TWILIO_IVR_TTS = process.env.TWILIO_IVR_TTS;
botiumConfig.botium.Capabilities.DEEPGRAM_API_KEY =
  process.env.DEEPGRAM_API_KEY;
botiumConfig.botium.Capabilities.DEEPGRAM_STT_MODEL =
  process.env.DEEPGRAM_STT_MODEL;
botiumConfig.botium.Capabilities.DEEPGRAM_TTS_VOICE =
  process.env.DEEPGRAM_TTS_VOICE;
botiumConfig.botium.Capabilities.TWILIO_IVR_STATUS_CALLBACK =
  process.env.TWILIO_IVR_STATUS_CALLBACK;
botiumConfig.botium.Capabilities.BOTIUM_INBOUND_PROXY_START =
  process.env.BOTIUM_INBOUND_PROXY_START;
botiumConfig.botium.Capabilities.CLEANUPTEMPDIR = process.env.CLEANUPTEMPDIR;
botiumConfig.botium.Capabilities.TWILIO_IVR_RECORD =
  process.env.TWILIO_IVR_RECORD;
botiumConfig.botium.Capabilities.WAITFORBOTTIMEOUT =
  process.env.WAITFORBOTTIMEOUT;
botiumConfig.botium.Capabilities.SCRIPTING_ENABLE_MEMORY =
  process.env.SCRIPTING_ENABLE_MEMORY;
botiumConfig.botium.Capabilities.DEBUG = process.env.DEBUG;
botiumConfig.botium.Capabilities.SIMULATEDPORT = process.env.SIMULATEDPORT;

// Write updated config back to botium.json
fs.writeFileSync(botiumConfigPath, JSON.stringify(botiumConfig, null, 2));

console.log("✅ botium.json updated successfully!");

app.use(cors({ origin: "http://localhost:3001" }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3001",
    methods: ["GET", "POST"],
  },
});

const PORT = 3000;
let activeBots = new Map();
io.on("connection", (socket) => {
  console.log("A client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ Client ${socket.id} disconnected");

    // Stop and clean up the bot if it was running
    if (activeBots.has(socket.id)) {
      activeBots.get(socket.id).stopBot();
      activeBots.delete(socket.id);
    }
  });

  socket.on("start-botium-test", async () => {
    console.log(`🚀 Starting Botium test for ${socket.id}}`);

    try {
      const driver = new BotDriver();
      const bot = await driver.Build();
      await bot.Start();

      let userInput = "Hello";
      let isConversationActive = true;

      fs.writeFileSync("conversation_log.txt", "");

      function logConversation(input, response) {
        const timestamp = new Date().toISOString();
        const logEntry = { timestamp, user: input, bot: response };
        fs.appendFileSync(
          "conversation_log.txt",
          `\n[${timestamp}] User: ${input}\n[${timestamp}] Bot: ${response}\n`
        );
        socket.emit("bot-response", logEntry); // Send live updates
      }

      // Function to stop the bot session
      async function stopBot() {
        isConversationActive = false;
        await bot.Stop();
        console.log(`🛑 Stopped bot session for ${socket.id}`);
      }

      activeBots.set(socket.id, { stopBot });

      while (isConversationActive) {
        console.log(` 🗣️ User: ${userInput}`);
        await bot.UserSaysText(userInput);

        try {
          console.log("⏳ Waiting for bot response...");
          const botResponse = await bot.WaitBotSays();
          const botResponseText = botResponse.messageText.trim();

          console.log(`🤖 AI Voice Agent: ${botResponseText}`);
          logConversation(userInput, botResponseText);

          userInput = await generateDynamicInput(botResponseText);
          console.log(`🗣️ Generated Input: ${userInput}`);
        } catch (err) {
          console.error("❌ Error waiting for bot response:", err);
          break;
        }
      }

      await stopBot();
      socket.emit("bot-test-complete", { message: "Test completed" });
    } catch (error) {
      console.error("❌ Error running Botium test:", error);
      socket.emit("error", { message: error.message });
    }
  });
});

// Function to generate user input dynamically using OpenAI
async function generateDynamicInput(botResponseText) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You are a human user participating in a natural conversation. Do not mention AI or that you are an AI. Always respond like a normal person would.",
        },
        { role: "user", content: `Respond to: ${botResponseText} `},
      ],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI API Error:", error);
    return "I didn't understand that.";
  }
}

// Gracefully shutdown server and sockets
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down server...");

  io.sockets.sockets.forEach((socket) => {
    socket.disconnect(true);
  });

  server.close(() => {
    console.log("✅ Server closed.");
    process.exit(0);
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
}); 