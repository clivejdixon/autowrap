# Genesys Auto Wrap-up Helper

This embedded client app watches the current user's conversation notifications and automatically patches the participant wrap-up when all of the following are true:

- the event is for an email conversation
- the current user's agent participant has `wrapupRequired === true`
- the conversation custom attributes include `ForcedUnpark=true`
- the participant is not already wrapped with `CD_AutoUnparked`

It applies this payload:

```json
{
  "code": "ca8f495d-e32d-4c6d-b721-2b061ca80213",
  "name": "CD_AutoUnparked",
  "notes": "Unparked due to time limit"
}
```

## Why this design

Genesys documents the Client App SDK for embedded apps inside Genesys Cloud, the Platform JavaScript SDK for API access, and the notification flow of creating a channel and subscribing to `v2.users.{userId}.conversations`. Genesys also documents `wrapupRequired` as the signal that a participant still needs wrap-up, which makes it the right moment to patch the participant. See the official docs for the Client App SDK, the Platform SDK tutorial, notifications, and wrap-up. citeturn877197search0turn958186search2turn823179search4turn823179search22turn823179search2

## Project layout

- `index.html` - simple embedded UI and log console
- `src/main.js` - auth, notifications, detection, patch, and verification logic
- `src/config.example.js` - copy to `src/config.js` and fill in your values

## Setup

1. Copy `src/config.example.js` to `src/config.js`.
2. Set:
   - `clientId`
   - `redirectUri`
   - optional `authFlow` (`implicit` by default)
3. Install dependencies:

```bash
npm install
```

4. Run locally:

```bash
npm run dev
```

5. Build for deployment:

```bash
npm run build
```

6. Host the built app over HTTPS.
7. In Genesys Cloud, create a Client App integration pointing to the hosted URL.
8. In the Client App URL, enable URL interpolation for `gcTargetEnv`, and optionally `gcHostOrigin` and `gcLangTag`, because the Genesys tutorial notes these are commonly passed into embedded apps. citeturn958186search2turn958186search18

## OAuth configuration

For a browser-based client app, Genesys documents Implicit Grant for client-side browser applications and also notes that PKCE is the most secure option for stateful client-side web apps. This sample defaults to Implicit because the embedded Client App tutorial shows `loginImplicitGrant(...)`, but you can switch `authFlow` to `pkce` if your OAuth client is configured for PKCE and your SDK version supports `loginPKCEGrant(...)`. citeturn958186search4turn401663search13turn958186search2

## Required OAuth scopes and permissions

At minimum, the OAuth client should include browser-appropriate scopes for conversations, notifications, and users. The user or assigned role also needs permission to read/update the relevant conversation and participant data. Genesys notes that conversation custom attribute search requires `conversation:customAttributes:view`, and your wrap-up patching permissions must also be granted through the role assigned to the OAuth client/user. Verify the exact permissions in your org before rollout. citeturn731863search0turn958186search0turn823179search5

## Runtime behavior

1. Initialize the Client App SDK.
2. Authenticate the user with the Platform SDK.
3. Create a notifications channel.
4. Subscribe to `v2.users.{userId}.conversations`.
5. For each notification:
   - find the current user's agent participant
   - require `wrapupRequired === true`
   - retrieve custom attributes
   - require `ForcedUnpark=true`
   - patch wrap-up on the participant
   - verify the participant state after a short delay

## Important limitations

- This helper is designed to auto-submit wrap-up when Genesys actually marks the participant as wrap-up-required. It may not prevent the prompt from appearing briefly.
- Your earlier logs showed that writing wrap-up early does not necessarily clear `wrapupRequired` while the conversation is still parked.
- The helper deduplicates repeated events for 30 seconds per conversation+participant.
- If your notification payload does not include enough conversation detail, the helper falls back to REST lookups.

## Next hardening ideas

- Store the original owner user ID in custom attributes and require it to match the current user before patching.
- Add feature flags for only certain queues or wrap-up codes.
- Report patch outcomes to a small audit endpoint.
- Add exponential backoff and a retry ceiling when the patch is accepted but `wrapupRequired` remains true.
