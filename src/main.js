import platformClient from 'purecloud-platform-client-v2';
import ClientApp from 'purecloud-client-app-sdk';
import { config } from './config.js';

const apiClient = platformClient.ApiClient.instance;
const usersApi = new platformClient.UsersApi();
const notificationsApi = new platformClient.NotificationsApi();

const params = new URLSearchParams(window.location.search);
const gcTargetEnv = params.get('gcTargetEnv');

// Fallback for local dev
const REGION = gcTargetEnv || 'euw2.pure.cloud';

let clientApp;
let currentUser;
let notificationChannel;
let socket;
let running = false;

const recentlyPatched = new Map();

function log(message, level = 'info', data) {
  const ts = new Date().toISOString();
  console[level]( `[${ts}] ${message}`, data || '' );
}

function getTopic(userId) {
  return `v2.users.${userId}.conversationsummary`;
}

function getAccessToken() {
  return apiClient.authData?.accessToken || apiClient.accessToken;
}

async function authenticatedFetch(path, options = {}) {
  const token = getAccessToken();
  const url = `https://api.${REGION}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`${response.status} ${err}`);
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function authenticate() {
  apiClient.setEnvironment(REGION);

  await apiClient.loginImplicitGrant(config.clientId, config.redirectUri);

  currentUser = await usersApi.getUsersMe();
  log('Authenticated', 'info', currentUser.id);
}

async function initClientApp() {
  clientApp = new ClientApp({
    gcTargetEnv: REGION
  });
}

async function createNotificationChannel() {
  notificationChannel = await notificationsApi.postNotificationsChannels();

  await notificationsApi.postNotificationsChannelSubscriptions(
    notificationChannel.id,
    [{ id: getTopic(currentUser.id) }]
  );

  log('Subscribed to conversationsummary', 'info', {
    channelId: notificationChannel.id
  });
}

function connectWebSocket() {
  socket = new WebSocket(notificationChannel.connectUri);

  socket.addEventListener('open', () => {
    log('WebSocket connected');
  });

  socket.addEventListener('message', async (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (!payload.topicName || !payload.eventBody) return;

      await handleConversationNotification(payload.topicName, payload.eventBody);
    } catch (err) {
      log('WebSocket parse error', 'error', err.message);
    }
  });
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
    state: p?.state,
    wrapup: p?.wrapup
  };
}

/* 🔥 FINAL FIXED HANDLER */
async function handleConversationNotification(topicName, eventBody) {
  if (!topicName.includes('conversationsummary')) return;

  const conversationId =
    eventBody.conversationId ||
    eventBody.id;

  if (!conversationId) return;

  log('🔥 Event received', 'info', { conversationId });

  // 🔥 ALWAYS fetch real conversation state
  const convo = await authenticatedFetch(`/api/v2/conversations/emails/${conversationId}`);

  const agentParticipant = convo.participants.find(p =>
    p.userId === currentUser.id &&
    p.purpose === 'agent'
  );

  if (!agentParticipant) return;

  const { wrapupRequired, state } = agentParticipant;

  log('🔍 Live State', 'info', {
    conversationId,
    wrapupRequired,
    state
  });

  const interactionActive =
    state === 'wrapup' || state === 'connected';

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

    log('✅ Wrap-up applied', 'info', {
      conversationId,
      verification
    });

  } catch (err) {
    log('❌ Wrap-up failed', 'error', err.message);
  }
}

async function start() {
  if (running) return;
  running = true;

  await initClientApp();
  await authenticate();
  await createNotificationChannel();
  connectWebSocket();

  log('Auto-wrap helper started');
}

document.getElementById('startBtn').onclick = start;
