export const config = {
  clientId: 'REPLACE_WITH_YOUR_OAUTH_CLIENT_ID',
  redirectUri: 'https://YOUR-HOSTNAME.example.com/',
  persistKey: 'genesys-auto-wrapup-helper',
  authFlow: 'implicit',
  notificationTopicTemplate: 'v2.users.{userId}.conversations',
  wrapupPayload: {
    code: 'ca8f495d-e32d-4c6d-b721-2b061ca80213',
    name: 'CD_AutoUnparked',
    notes: 'Unparked due to time limit'
  },
  requiredCustomAttribute: {
    key: 'ForcedUnpark',
    value: true
  },
  pollVerificationMs: 1500,
  dedupeWindowMs: 30000,
  enableClientAppToast: true
};
