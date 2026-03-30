import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { agentRegistry } from '../agents/registry.js';
import type { AgentCommand } from '../agents/types.js';

const AGENT_WS_PATH_RE = /^\/ws\/agent\/([^/?]+)/;

export function isAgentWsUpgrade(url: string): boolean {
  return AGENT_WS_PATH_RE.test(url);
}

export function handleAgentWsUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const match = req.url?.match(AGENT_WS_PATH_RE);
  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const agent = agentRegistry.getAgent(sessionId);
  if (!agent) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log(`[agent-ws] Browser connected for agent session ${sessionId}`);

    // Register as browser client
    agentRegistry.addBrowserClient(sessionId, ws);

    // Send agent info
    const info = agent.getInfo();
    ws.send(JSON.stringify({ type: 'agent_info', ...info }));

    // Send history batch with tree data for atoo-any v2
    const messages = agent.getMessages();
    const batch: any = { type: 'history_batch', messages };

    if ('getSessionData' in agent) {
      const sessionData = (agent as any).getSessionData();
      if (sessionData) {
        batch.tree = sessionData.tree;
        batch.prompts = sessionData.prompts;
        batch.activePath = (agent as any).getActivePath();
        batch.sessionMetadata = sessionData.metadata;
      }
    }

    if (messages.length > 0 || batch.tree) {
      ws.send(JSON.stringify(batch));
    }

    // Send running dispatches (survives reconnect)
    if ('getRunningDispatches' in agent) {
      const running = (agent as any).getRunningDispatches();
      if (running.length > 0) {
        ws.send(JSON.stringify({ type: 'running_dispatches', dispatches: running }));
      }
    }

    // Handle incoming commands
    ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString()) as AgentCommand;
        handleCommand(sessionId, cmd);
      } catch (err) {
        console.error(`[agent-ws] Failed to parse command for ${sessionId}`);
      }
    });

    ws.on('close', () => {
      console.log(`[agent-ws] Browser disconnected for agent session ${sessionId}`);
      agentRegistry.removeBrowserClient(sessionId, ws);
    });

    ws.on('error', (err) => {
      console.error(`[agent-ws] Error for ${sessionId}:`, err.message);
    });
  });
}

function handleCommand(sessionId: string, cmd: AgentCommand): void {
  const agent = agentRegistry.getAgent(sessionId);
  if (!agent) return;

  switch (cmd.action) {
    case 'send_message':
      agent.sendMessage(cmd.text, cmd.attachments, {
        ...(cmd.agents ? { agents: cmd.agents } : {}),
        ...(cmd.agentSelectorConfig ? { agentSelectorConfig: cmd.agentSelectorConfig } : {}),
      });
      break;
    case 'approve':
      agent.approve(cmd.requestId, cmd.updatedInput);
      break;
    case 'deny':
      agent.deny(cmd.requestId);
      break;
    case 'answer_question':
      agent.answerQuestion(cmd.requestId, cmd.answers);
      break;
    case 'set_mode':
      agent.setMode(cmd.mode);
      break;
    case 'set_model':
      agent.setModel(cmd.model);
      break;
    case 'refresh_context':
      agent.refreshContext();
      break;
    case 'send_key':
      agent.sendKey(cmd.key);
      break;
    // Tree operations (atoo-any v2)
    case 'set_active_path':
      if ('switchBranch' in agent) (agent as any).switchBranch(cmd.activePath);
      break;
    case 'fork_conversation':
      if ('forkConversation' in agent) (agent as any).forkConversation(cmd.afterPromptUuid);
      break;
    case 'hide_prompts':
      if ('removeMessages' in agent) (agent as any).removeMessages(cmd.promptUuids);
      break;
    case 'compact_prompts':
      if ('compactMessages' in agent) (agent as any).compactMessages(cmd.promptUuids, cmd.compactedBy);
      break;
    case 'extract_prompts':
      if ('extractRange' in agent) {
        // extractRange uses indices but we now pass UUIDs - adapter handles it
        (agent as any).extractPrompts(cmd.promptUuids, cmd.label);
      }
      break;
    case 'kill_agent':
      if ('killAgent' in agent) (agent as any).killAgent(cmd.agentFamily);
      break;
    case 'kill_all_agents':
      if ('killAllAgents' in agent) (agent as any).killAllAgents();
      break;
    default: {
      const action = (cmd as any).action;
      if (action === 'session_viewed' || action === 'session_focus') {
        agentRegistry.setSessionFocused(sessionId);
      } else if (action === 'session_blur') {
        agentRegistry.setSessionBlurred(sessionId);
      } else {
        console.warn(`[agent-ws] Unknown command action for ${sessionId}:`, action);
      }
    }
  }
}
