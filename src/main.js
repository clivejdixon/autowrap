import platformClient from 'purecloud-platform-client-v2';
import ClientApp from 'purecloud-client-app-sdk';
import { config } from './config.js';

const apiClient = platformClient.ApiClient.instance;
const usersApi = new platformClient.UsersApi();
const notificationsApi = new platformClient.NotificationsApi();
const params = new URLSearchParams(window.location.search);

const gcHostOrigin = params.get('gcHostOrigin');
const gcTargetEnv = params.get('gcTargetEnv');

// Fallback if not embedded (local dev)
const REGION = gcTargetEnv || 'euw2.pure.cloud';
const BASE_URL = `https://api.${REGION}`;

console.log('Environment:', REGION);
console.log('Host Origin:', gcHostOrigin);

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
  elements.env.textContent = env;

  await apiClient.loginImplicitGrant(config.clientId, config.redirectUri);

  currentUser = await usersApi.getUsersMe();
  elements.user.textContent = `${currentUser.name}`;
}

async function initClientApp() {
  clientApp = new ClientApp({
    gcTargetEnv: getEnvironment()
  });
}

async function createNotificationChannel() {
  notificationChannel = await notificationsApi.postNotificationsChannels();

  await notificationsApi.postNotificationsChannelSubscriptions(
    notificationChannel.id,
    [{ id: getTopic(currentUser.id) }]
  );
}

function connectWebSocket() {
  socket = new WebSocket(notificationChannel.connectUri);

  socket.addEventListener('message', async (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.topicName || !payload.eventBody) return;

    await handleConversationNotification(payload.topicName, payload.eventBody);
  });
}

function isAgentParticipantForCurrentUser(p) {
  return p?.purpose === 'agent' && p?.userId === currentUser.id;
}

async function getConversationCustomAttributes(conversationId) {
  try {
    const attrs = await authenticatedFetch(`/api/v2/conversations/${conversationId}/customattributes`);
    return attrs?.customAttributes || attrs || {};
  } catch {
    return {};
  }
}

function matchesForcedUnpark(attrs) {
  return String(attrs?.ForcedUnpark).toLowerCase() === 'true';
}

async function patchAgentParticipantWrapup(conversationId, participantId) {
  return authenticatedFetch(
    `/api/v2/conversations/emails/${conversationId}/participants/${participantId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        wrapup: config.wrapupPayload
      })
    }
  );
}

async function verifyParticipant(conversationId, participantId) {
  await new Promise((r) => setTimeout(r, 300));

  const convo = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}`);
  const p = convo.participants.find((x) => (x.id || x.participantId) === participantId);

  return {
    wrapupRequired: p?.wrapupRequired,
    wrapup: p?.wrapup,
    state: p?.state
  };
}

async function waitForACWAndWrapup(conversationId, participantId) {
  const key = `${conversationId}:${participantId}`;
  if (recentlyPatched.has(key)) return;

  for (let i = 0; i < 6; i++) {
    const convo = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}`);
    const p = convo.participants.find(isAgentParticipantForCurrentUser);

    if (!p) return;

    const state = p.state;
    const active = state === 'wrapup' || state === 'connected';

    log('ACW Check', 'info', { state, wrapupRequired: p.wrapupRequired });

    if (p.wrapupRequired && active) {
      recentlyPatched.set(key, Date.now());

      await patchAgentParticipantWrapup(conversationId, participantId);

      const v = await verifyParticipant(conversationId, participantId);

      log('Wrap-up applied', 'info', v);
      return;
    }

    await new Promise((r) => setTimeout(r, 400));
  }
}

async function handleConversationNotification(topicName, eventBody) {
  if (!topicName.includes('conversationsummary')) return;

  const conversationId = eventBody.conversationId;
  if (!conversationId) return;

  const participants = eventBody.participants || [];

  const agentParticipant = participants.find(p =>
    p.userId === currentUser.id && p.purpose === 'agent'
  );

  if (!agentParticipant) return;

  const wrapupRequired = agentParticipant.wrapupRequired;
  const state = agentParticipant.state;

  log('Summary Event Check', 'info', {
    conversationId,
    wrapupRequired,
    state
  });

  const interactionActive = state === 'wrapup' || state === 'connected';

  if (!wrapupRequired || !interactionActive) return;

  const attrs = await getConversationCustomAttributes(conversationId);
  if (!matchesForcedUnpark(attrs)) return;

  const participantId = agentParticipant.id;

  const key = `${conversationId}:${participantId}`;
  if (recentlyPatched.has(key)) return;

  recentlyPatched.set(key, Date.now());

  try {
    await patchAgentParticipantWrapup(conversationId, participantId);

    const verification = await verifyParticipant(conversationId, participantId);

    log('✅ Wrap-up applied (summary event)', 'info', {
      conversationId,
      verification
    });

  } catch (err) {
    log('❌ Wrap-up failed', 'error', err.message);
  }
}

async function start() {
  await initClientApp();
  await authenticate();
  await createNotificationChannel();
  connectWebSocket();
}

elements.startBtn.onclick = start;
