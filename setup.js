#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Determine the platform-specific MCP settings file path
const getMcpSettingsPath = () => {
  const platform = os.platform();
  const homedir = os.homedir();
  
  if (platform === 'win32') {
    return path.join(process.env.APPDATA, 'cursor', 'user', 'mcp_settings.json');
  } else if (platform === 'darwin' || platform === 'linux') {
    return path.join(homedir, '.config', 'cursor', 'user', 'mcp_settings.json');
  } else {
    console.log(`Unknown platform: ${platform}. Please manually configure your MCP settings.`);
    return null;
  }
};

// Get absolute path of current directory
const getCurrentDir = () => {
  return path.resolve(__dirname);
};

// Generate a random JWT secret
const generateSecret = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Update the cursor-plug.json file with the current path
const updateCursorPlugJson = (currentPath) => {
  const cursorPlugPath = path.join(__dirname, 'cursor-plug.json');
  
  try {
    const cursorPlugData = JSON.parse(fs.readFileSync(cursorPlugPath, 'utf8'));
    
    // Use path.join with relative path for cross-platform compatibility
    cursorPlugData.mcpServers['cursorkleo-mcp-server'].args = [
      path.join(currentPath, 'build', 'index.js')
    ];
    
    // Generate a new JWT secret
    const secret = generateSecret();
    cursorPlugData.mcpServers['cursorkleo-mcp-server'].env.JWT_SECRET = secret;
    
    fs.writeFileSync(cursorPlugPath, JSON.stringify(cursorPlugData, null, 2));
    console.log('Updated cursor-plug.json with current path and new JWT secret.');
    
    // Also create a .env file based on the template
    try {
      if (fs.existsSync(path.join(__dirname, '.env.example'))) {
        let envContent = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
        envContent = envContent.replace('your_jwt_secret_key_here', secret);
        fs.writeFileSync(path.join(__dirname, '.env'), envContent);
        console.log('Created .env file with new JWT secret.');
      }
    } catch (envError) {
      console.warn('Warning: Could not create .env file:', envError);
    }
    
    return cursorPlugData;
  } catch (error) {
    console.error('Failed to update cursor-plug.json:', error);
    return null;
  }
};

// Update or create the MCP settings file
const updateMcpSettings = (plugData, mcpSettingsPath) => {
  try {
    let mcpSettings = {};
    
    // Try to read existing settings
    if (fs.existsSync(mcpSettingsPath)) {
      try {
        mcpSettings = JSON.parse(fs.readFileSync(mcpSettingsPath, 'utf8'));
      } catch (error) {
        console.log('Could not parse existing MCP settings, creating new file.');
      }
    } else {
      // Ensure directory exists
      const settingsDir = path.dirname(mcpSettingsPath);
      if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
      }
    }
    
    // Add or update our server config
    mcpSettings.mcpServers = mcpSettings.mcpServers || {};
    mcpSettings.mcpServers['cursorkleo-mcp-server'] = plugData.mcpServers['cursorkleo-mcp-server'];
    
    fs.writeFileSync(mcpSettingsPath, JSON.stringify(mcpSettings, null, 2));
    console.log(`MCP settings updated at: ${mcpSettingsPath}`);
    
    return true;
  } catch (error) {
    console.error('Failed to update MCP settings:', error);
    return false;
  }
};

// Main setup function
const setup = async () => {
  console.log('Setting up cursorkleo-mcp-server...');
  
  const currentDir = getCurrentDir();
  console.log(`Current directory: ${currentDir}`);
  
  // Update cursor-plug.json
  const plugData = updateCursorPlugJson(currentDir);
  if (!plugData) {
    console.log('Setup failed. Please check the error and try again.');
    process.exit(1);
  }
  
  // Get MCP settings path
  const mcpSettingsPath = getMcpSettingsPath();
  if (!mcpSettingsPath) {
    console.log('Could not determine MCP settings path. Setup incomplete.');
    process.exit(1);
  }
  
  // Ask for confirmation
  rl.question(`This will update your MCP settings at: ${mcpSettingsPath}\nContinue? (y/n) `, (answer) => {
    if (answer.toLowerCase() === 'y') {
      const success = updateMcpSettings(plugData, mcpSettingsPath);
      
      if (success) {
        console.log('\nSetup complete! You can now build and start the MCP server with:');
        console.log('npm run build');
        console.log('npm start');
        console.log('\nMake sure to restart Cursor to apply the changes.');
      } else {
        console.log('\nSetup failed. Please check the error and try again.');
      }
    } else {
      console.log('\nSetup cancelled. You can manually update your MCP settings later.');
    }
    
    rl.close();
  });
};

// Run the setup
setup(); 