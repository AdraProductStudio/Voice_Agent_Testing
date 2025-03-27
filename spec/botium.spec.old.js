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

app.use(cors({ origin: "http://localhost:3001" }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3001",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;
let activeBots = new Map(); // Track active bot sessions

io.on("connection", (socket) => {
  console.log("🔥 A client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log(`❌ Client ${socket.id} disconnected`);
    
    // Stop and clean up the bot if it was running
    if (activeBots.has(socket.id)) {
      activeBots.get(socket.id).stopBot();
      activeBots.delete(socket.id);
    }
  });

  socket.on("start-botium-test", async () => {
    console.log(`🚀 Starting Botium test for ${socket.id}`);

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
        { role: "user", content: `Respond to: ${botResponseText}` },
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
