# Cursor Collaboration Server

Hey there! 👋 This is a friendly collaboration server for Cursor that lets you code together with friends or colleagues in real-time. No more clunky Git workflows when you just want to pair program or help someone debug their code!

## What does this do?

Ever wished you could just hop into someone's Cursor editor and help them out? That's exactly what this server enables:

- See each other's cursors moving in real-time (like Google Docs)
- Chat with teammates right in the editor
- Share AI assistance across the team
- Works on Windows, Mac, and Linux

## Before you start

You'll need:
- Node.js version 16 or newer
- npm (comes with Node.js)
- Cursor Editor installed

## Getting started

### Step 1: Get the code

```bash
git clone <repository-url>
cd cursorkleo-mcp-server
```

### Step 2: Install the stuff it needs

```bash
npm install
```

### Step 3: Build it

```bash
npm run build
```

### Step 4: Set it up

The easiest way is to run:

```bash
npm run setup
```

This magic script will:
- Create a secure secret key
- Update all the file paths to work on your computer
- Set up your Cursor to recognize the server
- Create a configuration file with all the settings

If you prefer doing things manually, you can:
1. Copy `.env.example` to `.env` and fill in your details
2. Fix the paths in `cursor-plug.json` to match your setup
3. Copy the settings into your Cursor config:
   - Windows: `%APPDATA%\cursor\user\mcp_settings.json`
   - Mac/Linux: `~/.config/cursor\user\mcp_settings.json`

### Step 5: Start the server

```bash
npm start
```

That's it! Your collaboration server is now running.

## During development

If you're working on improving this server, use:

```bash
npm run dev
```

This will automatically restart the server whenever you make changes.

## How it works

This server actually runs two services:

1. A WebSocket server on port 3001 - This handles all the real-time editing
2. A web interface on port 3002 - For monitoring and managing the server

## Settings you can change

These go in your `.env` file:

| Setting | What it does | Default |
|---------|--------------|---------|
| PORT | The main collaboration port | 3001 |
| WEB_PORT | The monitoring website port | 3002 |
| JWT_SECRET | Security key (will be generated for you) | (random) |
| LOG_LEVEL | How much detail in logs (debug, info, warn, error) | info |
| OPENAI_API_KEY | Your OpenAI API key for AI features | - |
| ANTHROPIC_API_KEY | Your Anthropic API key for AI features | - |

## Fixing common problems

- **Can't connect**: Make sure the server is running and your firewall isn't blocking the ports
- **Authentication errors**: Your security key might be wrong - run setup again
- **No AI responses**: Did you add your API keys to the .env file?

### Windows users

If you get permission errors, try running your terminal as Administrator.

### Mac/Linux users

You might need to make the launch file executable:
```bash
chmod +x build/index.js
```

## Want to help?

Contributions make this project better! Feel free to submit pull requests.

## License

This project uses the [MIT License](LICENSE). 