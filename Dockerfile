# Use an official Python runtime as a parent image
FROM node:18-alpine

RUN apk add --no-cache curl unzip

# Download and install ngrok binary
RUN curl -L https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-stable-linux-amd64.zip -o ngrok.zip \
    && unzip ngrok.zip \
    && mv ngrok /usr/local/bin/ngrok \
    && rm ngrok.zip

# Set working directory
WORKDIR /app

# Install global dependencies
RUN npm install -g botium-cli


# Install project dependencies
RUN npm install \
    compression \
    botium-bindings \
    botium-connector-twilio-ivr \
    twilio \
    openai \
    fs \
    ngrok \
    mocha \
    chai \
    dotenv

# Initialize Botium
RUN botium-cli init \
    && npx botium-bindings init

# Copy application files
COPY . .

# Configure ports
EXPOSE 4040 3000

# Entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]