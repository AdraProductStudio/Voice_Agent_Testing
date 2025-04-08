const express = require("express");
const http = require("http");
const { BotDriver } = require("botium-core");
const OpenAI = require("openai");
const cors = require("cors");
const compression = require("compression");
const ngrok = require("@ngrok/ngrok");
const twilio = require('twilio');
const axios = require('axios');
require("dotenv").config();

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = 3001;
const requestTimeout = 5 * 60 * 1000;
const botiumInstances = new Map(); // Store Botium instances for each user
let available_domains = process.env.NGROCK_DOMAIN_LIST?.split(',') || []

app.use(compression({ filter: (req, res) => req.path !== "/start-botium-test" }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json());

// Function to generate a random port
function generateRandomPort() {
  return Math.floor(Math.random() * (65535 - 1024 + 1)) + 1024;
}

// Function to start ngrok with a dynamic port and fetch the public URL
async function startNgrok() {
  try {
    const randomPort = generateRandomPort(); // Generate a random port
    console.log(`Starting ngrok on port ${randomPort}...`);
    // Assuming at least one available domain
    if (available_domains.length > 0) {
      let assigning_domain = available_domains[0];
      available_domains.shift();

      const listener = await ngrok.connect({
        proto: "http",
        domain: assigning_domain,
        addr: randomPort,
        authtoken: process.env.NGROK_AUTH_TOKEN,
      });

      if (listener && listener.url()) {
        const publicUrl = listener.url();
        console.log("Ngrok tunnel established at:", publicUrl);
        let ngrok_data = { url: publicUrl, port: randomPort, assigned_domain: assigning_domain };

        return ngrok_data
      } else {
        throw new Error("Ngrok did not return a valid listener object with a URL.");
      }
    } else {
      console.log("No available domains.");
      return null; // No available domains
    }
  } catch (error) {
    console.error("Error starting ngrok:", error.message);
    throw error;
  }
}

// Function to load botium config from the template and update dynamically
async function loadBotiumConfig(inboundNumber) {
  try {
    const ngrok_response = await startNgrok(); // Get ngrok public URL dynamically
    if (ngrok_response) {
      let botiumConfig = {
        PROJECTNAME: process.env.PROJECTNAME,
        CONTAINERMODE: process.env.CONTAINERMODE,
        TWILIO_IVR_ACCOUNT_SID: process.env.TWILIO_IVR_ACCOUNT_SID,
        TWILIO_IVR_AUTH_TOKEN: process.env.TWILIO_IVR_AUTH_TOKEN,
        TWILIO_IVR_FROM: process.env.TWILIO_IVR_FROM,
        TWILIO_IVR_INBOUNDPORT: ngrok_response.port,
        TWILIO_IVR_PUBLICURL: ngrok_response.url,
        TWILIO_CALL_DIRECTION: process.env.TWILIO_CALL_DIRECTION,
        TWILIO_IVR_STT: process.env.TWILIO_IVR_STT,
        TWILIO_IVR_TTS: process.env.TWILIO_IVR_TTS,
        DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
        DEEPGRAM_STT_MODEL: process.env.DEEPGRAM_STT_MODEL,
        DEEPGRAM_TTS_VOICE: process.env.DEEPGRAM_TTS_VOICE,
        TWILIO_IVR_STATUS_CALLBACK: `${ngrok_response.url}/twilio-ivr/status`,
        BOTIUM_INBOUND_PROXY_START: process.env.BOTIUM_INBOUND_PROXY_START,
        TWILIO_IVR_RECORD: process.env.TWILIO_IVR_RECORD,
        TWILIO_IVR_TO: inboundNumber,
        CLEANUPTEMPDIR: process.env.CLEANUPTEMPDIR,
        WAITFORBOTTIMEOUT: process.env.WAITFORBOTTIMEOUT,
        DEBUG: process.env.DEBUG,
        SIMULATEDPORT: process.env.SIMULATEDPORT
      };

      console.log('\n---------------------------Remaining available domains---------------------------');
      console.log(available_domains);
      console.log('\n---------------------------------------------------------------------------------');

      return { config: botiumConfig, assigned_domain: ngrok_response.assigned_domain };
    } else {
      return null; // No ngrok response
    }
  } catch (error) {
    console.error("Error creating ngrok tunnel:", error);
  }
}

// Initialize Botium container for each user with concurrency lock
async function initializeBotium(userId, inboundNumber) {
  if (!botiumInstances[userId]) {
    console.log('\n---------------------------Starting the Botium container---------------------------');
    console.error(`for user: ${userId}`);

    const botiumConfig = await loadBotiumConfig(inboundNumber);
    if (botiumConfig) {
      botiumInstances[userId] = {
        isInitializing: true,
        isStopping: false,
        ngrok_domain: botiumConfig.config.TWILIO_IVR_PUBLICURL,
        assigned_domain: botiumConfig.assigned_domain,
        promise: (async () => {
          const botiumDriver = new BotDriver(botiumConfig.config);
          const botiumContainer = await botiumDriver.Build();
          await botiumContainer.Start();
          console.log(`✅ Botium container started for user: ${userId}`);

          botiumInstances[userId].instance = botiumContainer;
          botiumInstances[userId].isInitializing = false;
        })(),
      };

      await botiumInstances[userId].promise;
      botiumInstances[userId].sid = botiumInstances[userId].instance.pluginInstance.call.sid;
      return botiumInstances[userId].instance;
    } else {
      return null; // No botiumConfig response
    }
  }

}

// Get recording SID
app.post("/get-recording-by-sid", async (req, res) => {
  const { callSid } = req.body;

  if (!callSid) {
    return res.status(400).json({ error: "Missing required parameter: callSid." });
  }
  console.log(`\n---------------------------Getting recordings---------------------------`);
  console.log(`For call sid: ${callSid}...`);

  try {
    const recordings = await getRecordingSid(callSid);  // Fetch recording SID using the call SID

    if (recordings) {
      res.status(200).json({
        error_code: 0,
        message: "Recording fetched successfully.",
        data: {
          recordings: recordings.audioSrc,
        },
      });
    } else {
      res.status(404).json({ error_code: 404, message: "No recordings found for the provided callSid." });
    }
    console.log('\n-------------------------------------------------------------------------------');
  } catch (error) {
    console.error("Error fetching recording:", error.message);
    res.status(500).json({ error_code: 500, message: "Failed to fetch recording.", error: error.message });
  }
});

async function getRecordingSid(callSid) {
  try {
    const client = twilio(process.env.TWILIO_IVR_ACCOUNT_SID, process.env.TWILIO_IVR_AUTH_TOKEN);
    let attempts = 0;

    while (attempts < 5) {  // Retry up to 5 times
      const recordings = await client.recordings.list({
        callSid: callSid
      });

      if (recordings.length > 0) {
        let mediaUrl = recordings[0]?.mediaUrl?.replace('https://', '') || '';
        mediaUrl = `https://${mediaUrl}`;

        const response = await axios.get(mediaUrl, {
          auth: {
            username: process.env.TWILIO_IVR_ACCOUNT_SID,
            password: process.env.TWILIO_IVR_AUTH_TOKEN
          },
          responseType: 'arraybuffer' // or stream, if needed
        });

        const base64Audio = Buffer.from(response.data).toString('base64');
        const contentType = response.headers['content-type']; // e.g., audio/mpeg or audio/wav

        return {
          audioSrc: `data:${contentType};base64,${base64Audio}`
        };
      }

      attempts++;
      await new Promise(resolve => setTimeout(resolve, 30000));  // Wait 30 seconds before retrying
    }

    console.log(`No recordings found after ${attempts} attempts`);
    return null;  // Return null if no recording found after retries

  } catch (error) {
    console.error("Error fetching recording SID:", error);
    throw error;
  }
}


// Stop the Botium session for a specific user
async function stopBotiumSession(userId, set_processing_event_to_false) {
  const botiumContainer = botiumInstances[userId];
  if (!botiumContainer) {
    console.log(`No Botium container found for user: ${userId}`);
    return;
  }

  let repush_domain = botiumContainer?.assigned_domain;
  if (!botiumContainer.isInitializing && !botiumContainer.isStopping) {
    console.log(`\n---------------------------Stopping Botium container---------------------------`);
    console.log(`For user: ${userId}...`);
    botiumContainer.isStopping = true;

    try {
      // Stop Botium instance
      if (botiumContainer.instance && typeof botiumContainer.instance.Stop === 'function') {
        console.log(`Attempting to disconnect ngrok...`);
        await botiumContainer.instance.Stop();  // Stop Botium instance
        console.log(`Botium instance stopped for user: ${userId}`);

        // Clean up the Botium container
        if (botiumContainer.instance.Clean) {
          await botiumContainer.instance.Clean();
          console.log(`Botium container cleaned for user: ${userId}`);
        }

        // Disconnect ngrok
        await ngrok.disconnect(botiumContainer.instance.caps.TWILIO_IVR_PUBLICURL);
        console.log(`Ngrok tunnel disconnected for user: ${userId}`);

        // Reclaim the ngrok domain if it was assigned
        if (botiumContainer.assigned_domain) {
          available_domains.push(repush_domain);
          console.log(`Reclaimed domain for user: ${userId}`);
        }

        // Remove the Botium instance from the map
        delete botiumInstances[userId];
        console.log(`Botium container stopped and deleted for user: ${userId}`);
      } else {
        console.error(`Botium container for user: ${userId} does not have Stop or Clean method.`);
      }
    } catch (error) {
      console.error("Error stopping Botium container:", error);
    } finally {
      botiumContainer.isStopping = false;
    }
  } else {
    console.log(`Botium container for user: ${userId} is either still initializing or already stopping.`);
  }
  console.log('\n-------------------------------------------------------------------------------');
}

// Generate dynamic input for Botium based on response from OpenAI
async function generateDynamicInput(botResponseText, systemPrompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Respond to: ${botResponseText}` },
      ]
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("\n\nOpenAI API Error:", error);
    return "I didn't understand that.";
  }
}

app.post("/start-botium-test", async (req, res) => {
  const { userId, inboundNumber, systemPrompt } = req.body;

  if (!userId || !inboundNumber || !systemPrompt) {
    return res.status(400).json({ error: "Missing required parameters." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  req.socket.setKeepAlive(true);
  res.flush();

  const timeoutId = setTimeout(async () => {
    if (botiumInstances[userId] && !botiumInstances[userId].isInitializing && !botiumInstances[userId].isStopping) {
      console.log(`Request timed out for user ${userId}.`);
      await stopBotiumSession(userId);
      res.write(`data: ${JSON.stringify({ error_code: 201, message: "Request timed out." })}\n\n`);
      res.end();
    }
  }, requestTimeout);

  function sendSSE(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.flush();
  }

  try {
    const botiumInstance = await initializeBotium(userId, inboundNumber);
    if (!botiumInstance) {
      sendSSE({ error_code: 201, message: "All servives are busy please try after sometime" });
      return
    }

    function logConversation(type, message) {
      const timestamp = new Date().toISOString();
      const logEntry = { conversation_by: type, userId, message, conversation_time: timestamp, call_id: botiumInstances[userId]?.sid };
      sendSSE({ error_code: 0, data: logEntry, message: "Conversation log" });
    }

    let userInput = "Hello";
    while (true) {
      // console.log(botiumInstances[userId])
      try {
        if (typeof botiumInstance.UserSaysText === 'function') {
          console.log(`User: ${userId}, message: ${userInput}`);
          await botiumInstance.UserSaysText(userInput);
          logConversation("user", userInput);
        } else {
          console.error("UserSaysText method not available on botiumInstance.");
          break;
        }

        const botResponse = await botiumInstance.WaitBotSays();
        const botResponseText = botResponse.messageText.trim();
        logConversation("bot", botResponseText);
        console.log(`Bot: ${userId}, message: ${botResponseText}`);

        if (/(bye|thank you!|feel free to ask|feel free to reach out)/i.test(botResponseText)) {
          await stopBotiumSession(userId);  // Stop Botium session and get the call_sid
          sendSSE({ error_code: 201, message: "Conversation ended." });  // Send call_sid in the response
          break;
        }

        userInput = await generateDynamicInput(botResponseText, systemPrompt);
      } catch (err) {
        console.log('\n---------------------------Conversation ERROR---------------------------');
        console.error("Bot response error:" + `user_id=${userId}`, err.message);
        console.log('\n-----------------------------------------------------------');
        await stopBotiumSession(userId);  // Stop Botium session and get the call_sid
        sendSSE({ error_code: 201, message: "Conversation ended." });  // Send call_sid in the response
        break;
      }
    }

    sendSSE({ error_code: 201, message: "Test completed" });
    res.end();
  } catch (error) {
    console.log('\n---------------------------Initialization ERROR---------------------------');
    console.error("Error running Botium test:" + `user_id=${userId}`, error.message);
    console.log('\n-----------------------------------------------------------');
  } finally {
    clearTimeout(timeoutId);
  }
});

app.post("/stop-botium-test", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId parameter." });

  try {
    await stopBotiumSession(userId, true);
    res.status(200).json({ error_code: 0, message: `Botium test stopped for user: ${userId}` });
  } catch (error) {
    console.log('\n---------------------------ERROR---------------------------');
    console.error("Error stopping Botium test:" + `user_id=${userId}`, error);
    console.log('\n-----------------------------------------------------------');

    res.status(201).json({ error_code: 201, data: {}, error: error.message });
  }
});

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

process.on("SIGINT", async () => {
  console.log('\n\n-------------🛑 SIGINT received. Shutting down gracefully 🛑------------------');

  try {
    const stopPromises = Object.keys(botiumInstances).map(async (userId) => {
      await stopBotiumSession(userId);
    });

    await Promise.all(stopPromises);
    console.log("All Botium sessions stopped.");

    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });

    // Force exit if it takes too long
    setTimeout(() => {
      console.log("⚠️ Force shutting down...");
      process.exit(1);
    }, 5000);
  } catch (err) {
    console.error("Error during cleanup", err);
    process.exit(1);
  }
});

process.on("uncaughtException", (err) => {
  console.log('\n\n-------------Uncaught Exception------------------');
  console.error(err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.log('\n\n-------------Unhandled Promise Rejection------------------');
  console.error(reason);
});