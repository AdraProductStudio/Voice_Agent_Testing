#!/bin/sh

# Set ngrok auth token
ngrok config add-authtoken ${NGROK_AUTH_TOKEN}

# Start ngrok tunnel in background
ngrok http localhost:3000 --domain mr-test.ngrok.app &

# Wait for ngrok to initialize
sleep 5

# Run tests
npx mocha spec/botium.spec.js

