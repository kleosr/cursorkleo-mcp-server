#!/usr/bin/env node

import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import path from 'path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server as SocketIOServer } from 'socket.io';
import http from 'http';

// Load environment variables
dotenv.config();

// Basic types
interface Client {
  ws: WebSocket;
  id: string; // Unique connection ID
  userId: string; // Authenticated User ID
  userName: string; // Authenticated User Name
  isAuthenticated: boolean;
  projectId?: string; // Which project the client is in
}

interface Message {
  type: string; // e.g., 'mcp_tool_call', 'chat_message', 'cursor_update'
  payload: any;
  requestId?: string; // Optional ID for request-response matching
}

// --- Server State ---
// Using simple Maps for now; consider a database for production
const clients = new Map<string, Client>(); // Map client ID to Client object
const projects = new Map<string, Set<string>>(); // Map project ID to Set of client IDs

// --- Configuration ---
const PORT = parseInt(process.env.PORT || '3001', 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || '3002', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_TIMEOUT_MS = 10000; // 10 seconds to authenticate

if (!JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not set.');
  process.exit(1); // Exit if secret is not configured
}

// Setup Express server for web interface
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server for Socket.IO
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// --- Express API Routes ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, projects: projects.size });
});

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket server started on port ${PORT}`);
console.log(`Web server started on port ${WEB_PORT}`);

wss.on('connection', (ws) => {
  const connectionId = uuidv4(); // Temporary ID for the connection before auth
  let client: Client | null = null; // Client object created upon successful auth
  console.log(`Connection attempt: ${connectionId}`);

  // Authentication Timeout
  const authTimeout = setTimeout(() => {
    if (!client || !client.isAuthenticated) {
      console.log(`Authentication timeout for connection ${connectionId}. Closing.`);
      ws.close(1008, 'Authentication timeout'); // 1008 = Policy Violation
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('message', (messageBuffer) => {
    try {
      const messageString = messageBuffer.toString();
      const message: Message = JSON.parse(messageString);
      const currentClientId = client ? client.id : connectionId; // Use connectionId if not authenticated yet

      console.log(`Received from ${currentClientId}:`, message.type); // Avoid logging full payload initially for security

      // --- Authentication Check ---
      if (!client || !client.isAuthenticated) {
        if (message.type === 'authenticate') {
          clearTimeout(authTimeout); // Clear timeout on receiving auth message
          try {
            client = handleAuthenticate(ws, connectionId, message.payload);
            if (client) {
              console.log(`Client authenticated: ${client.id} as ${client.userName} (${client.userId})`);
              clients.set(client.id, client); // Add to authenticated clients map
              // Send success message
              ws.send(JSON.stringify({ 
                type: 'auth_success', 
                payload: { 
                  userId: client.userId, 
                  userName: client.userName, 
                  clientId: client.id 
                } 
              }));
            } else {
              // handleAuthenticate should have closed the connection if auth failed
            }
          } catch (authError) {
            console.error(`Authentication error for ${connectionId}:`, authError);
            ws.send(JSON.stringify({ 
              type: 'auth_failure', 
              payload: { 
                error: authError instanceof Error ? authError.message : 'Authentication failed' 
              } 
            }));
            ws.close(1008, 'Authentication failed');
          }
        } else {
          // Message received before authentication
          console.warn(`Message type '${message.type}' received from unauthenticated connection ${connectionId}. Ignoring.`);
          ws.send(JSON.stringify({ type: 'error', payload: 'Authentication required' }));
        }
        return; // Do not process further messages until authenticated
      }

      // --- Authenticated Message Handling Logic ---
      console.log(`Processing message from authenticated client ${client.id}: ${message.type}`);
      switch (message.type) {
        case 'mcp_tool_call':
          handleMcpToolCall(client, message.payload, message.requestId);
          break;
        case 'chat_message':
          handleChatMessage(client, message.payload);
          break;
        // Add other authenticated message types
        default:
          console.warn(`Unknown message type from ${client.id}: ${message.type}`);
          ws.send(JSON.stringify({ 
            type: 'error', 
            payload: 'Unknown message type', 
            requestId: message.requestId 
          }));
      }
    } catch (error) {
      // Use currentClientId which is in scope here
      const currentClientId = client ? client.id : connectionId;
      console.error(`Failed to process message from ${currentClientId}:`, error);
      // Optionally send an error back to the client
      ws.send(JSON.stringify({ 
        type: 'error', 
        payload: 'Invalid message format' 
      }));
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout); // Clear timeout if connection closes before auth
    const clientId = client ? client.id : connectionId; // Use connectionId if client never authenticated
    console.log(`Client disconnected: ${clientId}`);

    if (client && client.isAuthenticated) {
      // --- Authenticated Client Cleanup Logic ---
      const projectId = client.projectId;
      if (projectId) {
        const projectClients = projects.get(projectId);
        if (projectClients) {
          projectClients.delete(client.userId); // Use userId for project membership
          if (projectClients.size === 0) {
            projects.delete(projectId);
            console.log(`Project closed: ${projectId}`);
          } else {
            // Broadcast user_left event
            broadcast(projectId, { 
              type: 'user_left', 
              payload: { 
                userId: client.userId, 
                userName: client.userName 
              } 
            }, client); // Exclude sender
          }
        }
      }
      clients.delete(client.id); // Remove from authenticated clients map
    }
    // No specific cleanup needed for unauthenticated connections other than logging
  });

  ws.on('error', (error) => {
    clearTimeout(authTimeout);
    const clientId = client ? client.id : connectionId;
    console.error(`WebSocket error for client ${clientId}:`, error);
    // Ensure cleanup happens even on error - 'close' event will handle it
    ws.close();
  });
});

// --- Socket.IO Setup ---
io.on('connection', (socket) => {
  console.log(`Socket.IO client connected: ${socket.id}`);
  
  // Handle admin monitoring connections
  socket.on('admin:auth', (token) => {
    // TODO: Implement admin authentication
    socket.emit('admin:stats', {
      clients: clients.size,
      projects: projects.size,
      timestamp: new Date().toISOString()
    });
  });
  
  socket.on('disconnect', () => {
    console.log(`Socket.IO client disconnected: ${socket.id}`);
  });
});

// --- Authentication Handler ---

interface JwtPayload {
  userId: string;
  userName: string;
  // Add other claims as needed (e.g., roles, permissions)
  iat?: number; // Issued at
  exp?: number; // Expiration time
}

function handleAuthenticate(ws: WebSocket, connectionId: string, payload: any): Client | null {
  const { token } = payload;
  if (!token || typeof token !== 'string') {
    throw new Error('Authentication token missing or invalid');
  }

  try {
    // Verify the token
    const decoded = jwt.verify(token, JWT_SECRET!) as JwtPayload; // Add '!' because we check JWT_SECRET at startup

    // Basic validation of payload
    if (!decoded.userId || !decoded.userName) {
      throw new Error('Invalid token payload: missing userId or userName');
    }

    // Create and return the authenticated client object
    const client: Client = {
      ws: ws,
      id: connectionId, // Use the initial connection ID as the client's unique ID for this session
      userId: decoded.userId,
      userName: decoded.userName,
      isAuthenticated: true,
      projectId: undefined // Not joined yet
    };
    return client;

  } catch (err) {
    console.error(`JWT verification failed for ${connectionId}:`, err);
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error(`Authentication failed: ${err.message}`);
    } else {
      throw new Error('Authentication failed: Unable to verify token');
    }
    // Connection will be closed by the caller
    return null; // Should not be reached due to throw, but satisfies TS
  }
}

// --- Tool Call Handler ---

async function handleMcpToolCall(client: Client, payload: any, requestId?: string) {
  // Assumes client is authenticated by the time this is called
  const { toolName, arguments: args } = payload;
  console.log(`Handling MCP tool call '${toolName}' for user ${client.userId}`);

  // Project join tool
  if (toolName === 'project:join') {
    const projectId = args.projectId;
    if (!projectId || typeof projectId !== 'string') {
      sendError(client, 'Missing or invalid projectId for project:join', requestId);
      return;
    }

    // --- TODO: Add Permission Check Here ---
    // Check if client.userId has permission to join projectId

    // Remove from old project if any (idempotent)
    if (client.projectId && client.projectId !== projectId) {
      const oldProjectClients = projects.get(client.projectId);
      if (oldProjectClients) {
        oldProjectClients.delete(client.userId);
        if (oldProjectClients.size === 0) {
          projects.delete(client.projectId);
          console.log(`Project closed: ${client.projectId}`);
        } else {
          broadcast(client.projectId, { 
            type: 'user_left', 
            payload: { 
              userId: client.userId, 
              userName: client.userName 
            } 
          }, client);
        }
      }
    }

    // Add to new project
    client.projectId = projectId;
    if (!projects.has(projectId)) {
      projects.set(projectId, new Set());
      console.log(`Project created: ${projectId}`);
    }
    projects.get(projectId)!.add(client.userId); // Use userId for membership

    console.log(`User ${client.userId} (${client.userName}) joined project ${projectId}`);

    // Send confirmation back to client
    sendResponse(client, { 
      success: true, 
      message: `Joined project ${projectId}` 
    }, requestId);

    // Broadcast user_joined to others in the project
    broadcast(projectId, { 
      type: 'user_joined', 
      payload: { 
        userId: client.userId, 
        userName: client.userName 
      } 
    }, client); // Exclude sender

  } else if (toolName === 'edit:send') {
    // --- Edit Handling Logic ---
    if (!client.projectId) {
      sendError(client, 'Cannot send edit: Not currently in a project', requestId);
      return;
    }
    const { fileId, changeData } = args; // changeData should be the patch array from diff-match-patch

    // Basic validation
    if (!fileId || typeof fileId !== 'string' || !changeData || !Array.isArray(changeData)) {
      sendError(client, 'Missing, invalid, or incorrectly formatted fileId or changeData for edit:send', requestId);
      return;
    }

    console.log(`Received edit for ${fileId} from user ${client.userId} in project ${client.projectId}`);

    // TODO: Add more robust validation of the patch format if needed

    // Broadcast the 'edit_applied' event to other clients in the same project
    broadcast(
      client.projectId,
      {
        type: 'edit_applied',
        payload: {
          fileId: fileId,
          changeData: changeData, // Forward the patch array
          sourceUserId: client.userId,
          sourceUserName: client.userName
        }
      },
      client // Exclude the sender
    );

    // Send confirmation back to the sender (optional)
    sendResponse(client, { success: true, message: 'Edit broadcasted' }, requestId);
    // --- End Edit Handling ---

  } else if (toolName.startsWith('ai:request_')) {
    // Ensure client is in a project
    if (!client.projectId) {
      sendError(client, 'Cannot request AI: Not currently in a project', requestId);
      return;
    }
    console.log(`AI request '${toolName}' received from user ${client.userId} for project ${client.projectId}`);
    // TODO: Implement AI request logic
    // - Gather necessary context (potentially fetch file content based on fileId, use project_config.md)
    // - Call external AI API (OpenAI, Anthropic)
    try {
      // Example: Generic AI call structure
      // Replace with actual API endpoint and payload structure
      const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY; // Try both keys
      if (!apiKey) {
        throw new Error(`API key for ${toolName} is not configured in environment variables.`);
      }

      // Determine API endpoint and payload based on toolName and args
      let apiEndpoint = '';
      let requestPayload = {};
      let headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      };

      if (toolName.includes('openai')) {
        apiEndpoint = 'https://api.openai.com/v1/chat/completions';
        requestPayload = {
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: args.prompt || args.codeSnippet || "How can I help you?" }
          ]
        };
      } else if (toolName.includes('anthropic')) {
        apiEndpoint = 'https://api.anthropic.com/v1/messages';
        requestPayload = {
          model: "claude-3-opus-20240229",
          messages: [
            { role: "user", content: args.prompt || args.codeSnippet || "How can I help you?" }
          ],
          max_tokens: 4000
        };
        headers = {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        };
      } else {
        throw new Error(`Unknown AI provider in tool: ${toolName}`);
      }

      console.log(`Calling AI API for ${toolName}...`);
      const response = await axios.post(apiEndpoint, requestPayload, { headers });

      // Extract result based on AI provider
      let aiResult = '';
      if (toolName.includes('openai')) {
        aiResult = response.data?.choices?.[0]?.message?.content || '';
      } else if (toolName.includes('anthropic')) {
        aiResult = response.data?.content?.[0]?.text || '';
      }

      // Send the result back to the client
      sendResponse(client, { success: true, result: aiResult }, requestId);
      console.log(`AI response sent for ${toolName}`);

    } catch (error: any) {
      console.error(`Error handling AI request ${toolName}:`, error.response?.data || error.message);
      sendError(client, `AI request failed: ${error.response?.data?.error?.message || error.message}`, requestId);
    }
    // --- End AI Request Handling ---

  } else if (toolName === 'cursor:update') {
    // --- Presence Handling ---
    if (!client.projectId) {
      sendError(client, 'Cannot update cursor: Not currently in a project', requestId);
      return;
    }
    const { fileId, position } = args; // position could be { line: number, column: number } or similar

    // Basic validation
    if (!fileId || typeof fileId !== 'string' || !position || typeof position !== 'object') {
      sendError(client, 'Missing or invalid fileId or position for cursor:update', requestId);
      return;
    }
    // TODO: Add more specific validation for the 'position' object structure

    // Broadcast cursor_moved to others in the same project
    // NOTE: This broadcasts *every* update. Consider adding throttling logic later
    // if performance becomes an issue (e.g., only send updates every 100ms per user).
    broadcast(
      client.projectId,
      {
        type: 'cursor_moved',
        payload: {
          fileId: fileId,
          position: position,
          sourceUserId: client.userId,
          sourceUserName: client.userName
        }
      },
      client // Exclude the sender
    );
    // No response typically needed for cursor updates, it's fire-and-forget
    // --- End Presence Handling ---

  } else {
    sendError(client, `MCP tool '${toolName}' not implemented`, requestId);
  }
}

function handleChatMessage(client: Client, payload: any) {
  // Assumes client is authenticated
  if (!client.projectId) {
    console.warn(`Chat message from user ${client.userId} not in a project.`);
    sendError(client, 'Cannot send chat: Not currently in a project');
    return;
  }
  const { message } = payload;
  if (!message || typeof message !== 'string' || message.trim() === '') {
    console.warn(`Invalid or empty chat message from user ${client.userId}.`);
    sendError(client, 'Invalid chat message');
    return;
  }
  console.log(`Chat message in ${client.projectId} from user ${client.userId}: ${message}`);
  // Broadcast new_chat_message to everyone in the project (including sender)
  broadcast(client.projectId, { 
    type: 'new_chat_message', 
    payload: { 
      userId: client.userId, 
      userName: client.userName, 
      message: message.trim() 
    } 
  });
}

// --- Utility Functions ---

function sendResponse(client: Client, payload: any, requestId?: string) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify({ 
      type: 'mcp_tool_response', 
      payload, 
      requestId 
    }));
  }
}

function sendError(client: Client, error: string, requestId?: string) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify({ 
      type: 'mcp_tool_response', 
      payload: { error }, 
      isError: true, 
      requestId 
    }));
  }
}

// Broadcast message to all clients associated with a specific project (by userId), optionally excluding one client
function broadcast(projectId: string, message: Message, excludeClient?: Client) {
  const projectUserIds = projects.get(projectId);
  if (!projectUserIds) return;

  const messageString = JSON.stringify(message);

  // Also broadcast to admin panel via Socket.IO
  io.emit('project:update', {
    projectId,
    eventType: message.type,
    timestamp: new Date().toISOString()
  });

  // Iterate through all authenticated clients to find matches for the project's userIds
  clients.forEach((client) => {
    // Check if client is authenticated, belongs to the target project, and is not the excluded client
    if (client.isAuthenticated && client.projectId === projectId && projectUserIds.has(client.userId)) {
      if (excludeClient && client.id === excludeClient.id) {
        return; // Skip the excluded client
      }
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(messageString);
      }
    }
  });
}

// Start HTTP server
httpServer.listen(WEB_PORT, () => {
  console.log(`HTTP server listening on port ${WEB_PORT}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  
  // Close WebSocket server
  wss.close(() => {
    console.log('WebSocket server closed.');
    
    // Close HTTP server
    httpServer.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
  });
  
  // Force close connections after a timeout
  setTimeout(() => {
    console.error('Forcing shutdown...');
    process.exit(1);
  }, 5000);
}); 