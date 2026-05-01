import platformClient from 'purecloud-platform-client-v2';
import ClientApp from 'purecloud-client-app-sdk';
import { config } from './config.js';

const apiClient = platformClient.ApiClient.instance;
const usersApi = new platformClient.UsersApi();
const notificationsApi = new platformClient.NotificationsApi();

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
  elements.log.textContent = `${line}\n${elements.log.textContent}`;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](message, data || '');
}

function setStatus(text) {
  elements.lastAction.textContent = text;
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
    throw new Error('Missing gcTargetEnv. Configure URL interpolation in the Genesys Client App URL.');
  }
  return env;
}

function getTopic(userId) {
  return config.notificationTopicTemplate.replace('{userId}', userId);
}

function getAccessToken() {
  const token = apiClient.authData?.accessToken || apiClient.accessToken;
  if (!token) {
    throw new Error('No access token available on ApiClient');
  }
  return token;
}

async function authenticatedFetch(path, options = {}) {
  const token = getAccessToken();
  const basePath = apiClient.apiClient?.config?.host || apiClient.environment || `https://api.${getEnvironment()}`;
  const url = path.startsWith('http') ? path : `${basePath}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText} ${errBody}`.trim());
  }

  if (response.status === 204) {
    return null;
  }

  return response.json().catch(() => null);
}

async function authenticate() {
  const env = getEnvironment();
  apiClient.setPersistSettings(true, config.persistKey);
  apiClient.setEnvironment(env);
  storeInterpolatedValues();
  elements.env.textContent = env;

  if (config.authFlow === 'implicit') {
    await apiClient.loginImplicitGrant(config.clientId, config.redirectUri);
  } else if (config.authFlow === 'pkce') {
    await apiClient.loginPKCEGrant(config.clientId, config.redirectUri);
  } else {
    throw new Error(`Unsupported authFlow: ${config.authFlow}`);
  }

  currentUser = await usersApi.getUsersMe();
  elements.user.textContent = `${currentUser.name} (${currentUser.id})`;
  return currentUser;
}

async function initClientApp() {
  const env = getEnvironment();
  clientApp = new ClientApp({
    gcTargetEnv: env
  });

  if (clientApp.lifecycle?.addEventListener) {
    clientApp.lifecycle.addEventListener('focus', () => log('Client app focused'));
  }
}

async function createNotificationChannel() {
  notificationChannel = await notificationsApi.postNotificationsChannels();
  elements.channel.textContent = notificationChannel.id;
  await notificationsApi.postNotificationsChannelSubscriptions(notificationChannel.id, [
    { id: getTopic(currentUser.id) }
  ]);
  log('Subscribed to notifications topic', 'info', { topic: getTopic(currentUser.id), channelId: notificationChannel.id });
}

function connectWebSocket() {
  socket = new WebSocket(notificationChannel.connectUri);

  socket.addEventListener('open', () => {
    log('WebSocket connected');
    setStatus('Listening for wrap-up-required events');
  });

  socket.addEventListener('close', (event) => {
    log('WebSocket closed', event.wasClean ? 'info' : 'warn', { code: event.code, reason: event.reason });
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
  return (eventBody.participants || []).some((p) => (p.calls || []).length || (p.messages || []).length || (p.sessions || []).some((s) => s.mediaType === 'email'));
}

async function getConversationCustomAttributes(conversationId) {
  try {
    const attrs = await authenticatedFetch(`/api/v2/conversations/${conversationId}/customattributes`);
    return attrs?.customAttributes || attrs || {};
  } catch (error) {
    log('Custom attributes endpoint failed; falling back to conversation GET', 'warn', { conversationId, message: error.message });
    try {
      const convo = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}`);
      return convo?.customAttributes || convo?.attributes || {};
    } catch (fallbackError) {
      log('Fallback conversation GET failed', 'warn', { conversationId, message: fallbackError.message });
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
  const result = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}/participants/${participantId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      wrapup: config.wrapupPayload
    })
  });
  return result;
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
  elements.startBtn.disabled = true;
  elements.stopBtn.disabled = false;

  try {
    await initClientApp();
    await authenticate();
    await createNotificationChannel();
    connectWebSocket();
    log('Helper started');
  } catch (error) {
    running = false;
    elements.startBtn.disabled = false;
    elements.stopBtn.disabled = true;
    log('Failed to start helper', 'error', { message: error.message });
    setStatus('Startup failed');
  }
}

async function stop() {
  running = false;
  elements.startBtn.disabled = false;
  elements.stopBtn.disabled = true;

  if (socket) {
    socket.close();
    socket = null;
  }

  if (notificationChannel?.id) {
    try {
      await notificationsApi.deleteNotificationsChannel(notificationChannel.id);
    } catch (error) {
      log('Failed to delete channel cleanly', 'warn', { channelId: notificationChannel.id, message: error.message });
    }
  }

  notificationChannel = null;
  elements.channel.textContent = '-';
  setStatus('Stopped');
  log('Helper stopped');
}

elements.startBtn.addEventListener('click', start);
elements.stopBtn.addEventListener('click', stop);
elements.clearBtn.addEventListener('click', () => {
  elements.log.textContent = '';
});

log('App loaded. Click Start helper after configuring src/config.js.');
