FROM node:20-slim

# Install system dependencies
RUN apk add --no-cache wget unzip

# Install ngrok
RUN wget https://bin.equinox.io/c/4VmDzA7iaHb/ngrok-stable-linux-amd64.zip \
&& unzip ngrok-stable-linux-amd64.zip -d /bin \
&& rm ngrok-stable-linux-amd64.zip

# Set working directory
WORKDIR /app

# Install global dependencies
RUN npm install -g botium-cli

# Install project dependencies
RUN npm install \
botium-bindings \
botium-connector-twilio-ivr \
twilio \
openai \
fs \
ngrok \
mocha \
chai

# Initialize Botium
RUN botium-cli init \
&& npx botium-bindings init

# Copy application files
COPY . .

# Configure ports
EXPOSE 45100 3000

# Entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]