#!/bin/sh

# Set ngrok auth token
ngrok config add-authtoken ${NGROK_AUTH_TOKEN}

# Start ngrok tunnel in background
ngrok http localhost:45100 --domain test-praveen.ngrok-free.app &

# Wait for ngrok to initialize
sleep 5

# Run tests
npx mocha spec/botium.spec.js


