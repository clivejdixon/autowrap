import platformClient from 'purecloud-platform-client-v2';
import ClientApp from 'purecloud-client-app-sdk';
import { config } from './config.js';

// Unmistakable load marker for browser console validation
console.log('🚀 AUTO-WRAP main.js loaded', {
  href: window.location.href,
  pathname: window.location.pathname,
  search: window.location.search,
  time: new Date().toISOString()
});
window.__AUTO_WRAP_MAIN_JS_LOADED__ = true;

const apiClient = platformClient.ApiClient.instance;
const usersApi = new platformClient.UsersApi();
const notificationsApi = new platformClient.NotificationsApi();
const params = new URLSearchParams(window.location.search);

const gcHostOrigin = params.get('gcHostOrigin');
const gcTargetEnv = params.get('gcTargetEnv');

// Fallback if not embedded (local dev)
const REGION = gcTargetEnv || 'euw2.pure.cloud';
const BASE_URL = `https://api.${REGION}`;

console.log('AUTO-WRAP Environment:', REGION);
console.log('AUTO-WRAP Host Origin:', gcHostOrigin);
console.log('AUTO-WRAP Base URL:', BASE_URL);

let clientApp;
let currentUser;
let notificationChannel;
let socket;
let running = false;
const recentlyPatched = new Map();

const elements = {
  env: document.getElementById('env'),
  user: document.getElementById('user'),
  channel: document.getElementById('channel'),
  lastAction: document.getElementById('lastAction'),
  log: document.getElementById('log'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn')
};

function log(message, level = 'info', data) {
  const ts = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data, null, 2)}` : '';
  const line = `[${ts}] ${message}${suffix}`;
  if (elements.log) {
    elements.log.textContent = `${line}\n${elements.log.textContent}`;
  }
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](message, data || '');
}

function setStatus(text) {
  if (elements.lastAction) {
    elements.lastAction.textContent = text;
  }
}

function getInterpolatedValue(name, fallback = '') {
  const search = new URLSearchParams(window.location.search);
  return search.get(name) || localStorage.getItem(name) || fallback;
}

function storeInterpolatedValues() {
  ['gcTargetEnv', 'gcHostOrigin', 'gcLangTag'].forEach((key) => {
    const value = new URLSearchParams(window.location.search).get(key);
    if (value) {
      localStorage.setItem(key, value);
    }
  });
}

function getEnvironment() {
  const env = getInterpolatedValue('gcTargetEnv');
  if (!env) {
    throw new Error('Missing gcTargetEnv.');
  }
  return env;
}

function getTopic(userId) {
  return `v2.users.${userId}.conversationsummary`;
}

function getAccessToken() {
  const token = apiClient.authData?.accessToken || apiClient.accessToken;
  if (!token) {
    throw new Error('No access token');
  }
  return token;
}

async function authenticatedFetch(path, options = {}) {
  const token = getAccessToken();
  const basePath = `https://api.${getEnvironment()}`;
  const url = `${basePath}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText} ${err}`);
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function authenticate() {
  const env = getEnvironment();
  apiClient.setPersistSettings(true, config.persistKey);
  apiClient.setEnvironment(env);
  storeInterpolatedValues();

  if (elements.env) {
    elements.env.textContent = env;
  }

  log('authenticate() starting', 'info', {
    env,
    authFlow: config.authFlow,
    clientId: config.clientId ? `${String(config.clientId).slice(0, 8)}...` : '(missing)'
  });

  if (config.authFlow === 'implicit') {
    await apiClient.loginImplicitGrant(config.clientId, config.redirectUri);
  } else if (config.authFlow === 'pkce') {
    await apiClient.loginPKCEGrant(config.clientId, config.redirectUri);
  } else {
    throw new Error(`Unsupported authFlow: ${config.authFlow}`);
  }

  currentUser = await usersApi.getUsersMe();
  if (elements.user) {
    elements.user.textContent = `${currentUser.name} (${currentUser.id})`;
  }

  log('authenticate() complete', 'info', {
    userId: currentUser.id,
    userName: currentUser.name
  });

  return currentUser;
}

async function initClientApp() {
  const env = getEnvironment();
  log('initClientApp() starting', 'info', { env });

  clientApp = new ClientApp({
    gcTargetEnv: env
  });

  if (clientApp.lifecycle?.addEventListener) {
    clientApp.lifecycle.addEventListener('focus', () => log('Client app focused'));
  }

  log('initClientApp() complete', 'info');
}

async function createNotificationChannel() {
  log('createNotificationChannel() starting', 'info');

  notificationChannel = await notificationsApi.postNotificationsChannels();
  if (elements.channel) {
    elements.channel.textContent = notificationChannel.id;
  }

  const topic = getTopic(currentUser.id);
  await notificationsApi.postNotificationsChannelSubscriptions(notificationChannel.id, [
    { id: topic }
  ]);

  log('Subscribed to notifications topic', 'info', {
    topic,
    channelId: notificationChannel.id,
    connectUri: notificationChannel.connectUri
  });
}

function connectWebSocket() {
  log('connectWebSocket() starting', 'info', {
    connectUri: notificationChannel?.connectUri
  });

  socket = new WebSocket(notificationChannel.connectUri);

  socket.addEventListener('open', () => {
    log('WebSocket connected');
    setStatus('Listening for wrap-up-required events');
  });

  socket.addEventListener('close', (event) => {
    log('WebSocket closed', event.wasClean ? 'info' : 'warn', {
      code: event.code,
      reason: event.reason
    });
    if (running) {
      setStatus('Socket closed; restart helper');
    }
  });

  socket.addEventListener('error', () => {
    log('WebSocket error', 'error');
    setStatus('Socket error');
  });

  socket.addEventListener('message', async (event) => {
    try {
      const payload = JSON.parse(event.data);

      log('🔥 Notification received', 'info', {
        topicName: payload.topicName,
        hasEventBody: !!payload.eventBody,
        eventBodyId: payload.eventBody?.id || payload.eventBody?.conversationId || null
      });

      if (!payload.topicName || !payload.eventBody) return;

      await handleConversationNotification(payload.topicName, payload.eventBody);
    } catch (error) {
      log('Failed to process notification', 'error', { message: error.message });
    }
  });
}

function isAgentParticipantForCurrentUser(participant) {
  return participant?.purpose === 'agent' && participant?.userId === currentUser.id;
}

function isEmailConversation(eventBody) {
  return (eventBody.participants || []).some(
    (p) =>
      (p.calls || []).length ||
      (p.messages || []).length ||
      (p.sessions || []).some((s) => s.mediaType === 'email')
  );
}

async function getConversationCustomAttributes(conversationId) {
  try {
    const attrs = await authenticatedFetch(`/api/v2/conversations/${conversationId}/customattributes`);
    return attrs?.customAttributes || attrs || {};
  } catch (error) {
    log('Custom attributes endpoint failed; falling back to conversation GET', 'warn', {
      conversationId,
      message: error.message
    });
    try {
      const convo = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}`);
      return convo?.customAttributes || convo?.attributes || {};
    } catch (fallbackError) {
      log('Fallback conversation GET failed', 'warn', {
        conversationId,
        message: fallbackError.message
      });
      return {};
    }
  }
}

function matchesForcedUnpark(attributes) {
  const actual = attributes?.[config.requiredCustomAttribute.key];
  return String(actual).toLowerCase() === String(config.requiredCustomAttribute.value).toLowerCase();
}

function shouldPatch(participant, conversationId) {
  if (!participant?.wrapupRequired) return false;
  if (participant?.wrapup?.code === config.wrapupPayload.code) return false;

  const dedupeKey = `${conversationId}:${participant.id || participant.participantId}`;
  const lastPatched = recentlyPatched.get(dedupeKey) || 0;
  return Date.now() - lastPatched > config.dedupeWindowMs;
}

async function patchAgentParticipantWrapup(conversationId, participantId) {
  return authenticatedFetch(`/api/v2/conversations/emails/${conversationId}/participants/${participantId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      wrapup: config.wrapupPayload
    })
  });
}

async function verifyParticipant(conversationId, participantId) {
  await new Promise((resolve) => setTimeout(resolve, config.pollVerificationMs));
  const convo = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}`);
  const participant = (convo.participants || []).find((p) => (p.id || p.participantId) === participantId);

  return {
    participantId,
    wrapupRequired: participant?.wrapupRequired,
    wrapup: participant?.wrapup || null,
    state: participant?.state || participant?.participantState || null
  };
}

async function handleConversationNotification(topicName, eventBody) {
  log('handleConversationNotification()', 'info', {
    topicName,
    eventBodyId: eventBody?.id || eventBody?.conversationId || null
  });

  if (topicName !== getTopic(currentUser.id)) return;
  if (!isEmailConversation(eventBody)) return;

  const conversationId = eventBody.id || eventBody.conversationId;
  if (!conversationId) return;

  const agentParticipant = (eventBody.participants || []).find(isAgentParticipantForCurrentUser);
  if (!agentParticipant) return;

  if (!agentParticipant.wrapupRequired) {
    return;
  }

  const participantId = agentParticipant.id || agentParticipant.participantId;
  const attributes = await getConversationCustomAttributes(conversationId);

  log('Notification candidate detected', 'info', {
    conversationId,
    participantId,
    wrapupRequired: agentParticipant.wrapupRequired,
    forcedUnpark: attributes?.ForcedUnpark,
    existingWrapup: agentParticipant.wrapup || null
  });

  if (!matchesForcedUnpark(attributes)) {
    return;
  }

  if (!shouldPatch(agentParticipant, conversationId)) {
    return;
  }

  const dedupeKey = `${conversationId}:${participantId}`;
  recentlyPatched.set(dedupeKey, Date.now());
  setStatus(`Patching wrap-up for ${conversationId}`);

  try {
    await patchAgentParticipantWrapup(conversationId, participantId);
    const verification = await verifyParticipant(conversationId, participantId);

    log('Auto wrap-up patch sent', 'info', {
      conversationId,
      participantId,
      verification
    });
    setStatus(`Patched ${conversationId}`);

    if (config.enableClientAppToast && clientApp?.alerting?.showToastPopup) {
      clientApp.alerting.showToastPopup({
        title: 'Auto wrap-up applied',
        message: `Conversation ${conversationId} patched with ${config.wrapupPayload.name}`
      });
    }
  } catch (error) {
    log('Auto wrap-up patch failed', 'error', {
      conversationId,
      participantId,
      message: error.message
    });
    setStatus(`Patch failed for ${conversationId}`);
  }
}

async function start() {
  if (running) return;
  running = true;

  if (elements.startBtn) elements.startBtn.disabled = true;
  if (elements.stopBtn) elements.stopBtn.disabled = false;

  log('start() clicked', 'info');

  try {
    await initClientApp();
    await authenticate();
    await createNotificationChannel();
    connectWebSocket();
    log('Helper started');
  } catch (error) {
    running = false;
    if (elements.startBtn) elements.startBtn.disabled = false;
    if (elements.stopBtn) elements.stopBtn.disabled = true;
    log('Failed to start helper', 'error', { message: error.message, stack: error.stack });
    setStatus('Startup failed');
  }
}

async function stop() {
  running = false;

  if (elements.startBtn) elements.startBtn.disabled = false;
  if (elements.stopBtn) elements.stopBtn.disabled = true;

  if (socket) {
    socket.close();
    socket = null;
  }

  if (notificationChannel?.id) {
    try {
      await notificationsApi.deleteNotificationsChannel(notificationChannel.id);
    } catch (error) {
      log('Failed to delete channel cleanly', 'warn', {
        channelId: notificationChannel.id,
        message: error.message
      });
    }
  }

  notificationChannel = null;

  if (elements.channel) {
    elements.channel.textContent = '-';
  }

  setStatus('Stopped');
  log('Helper stopped');
}

if (elements.startBtn) elements.startBtn.addEventListener('click', start);
if (elements.stopBtn) elements.stopBtn.addEventListener('click', stop);
if (elements.clearBtn) {
  elements.clearBtn.addEventListener('click', () => {
    if (elements.log) {
      elements.log.textContent = '';
    }
  });
}

log('App loaded. Click Start helper after configuring src/config.js.');
