# iCallMate Integration

This project exposes the iCallMate telephony WebSocket from the existing Node/Express server. A separate Python WSS server is not required.

## Production URLs

- WebSocket media URL: `wss://<APP_BASE_URL>/icallmate/media`
- Callback URL: `https://<APP_BASE_URL>/api/icallmate/callback`
- Local config helper: `GET /api/icallmate/config`

The app expects iCallMate media payloads as `8000 Hz`, `LINEAR16`, `1 channel`, `16 bits`.

## Incoming Calls

iCallMate should set these DNIS macros for the virtual number:

```json
[
  {
    "dnisNo": "07971644996",
    "macroName": "llm_wssurl",
    "macroValue": "wss://<APP_BASE_URL>/icallmate/media"
  },
  {
    "dnisNo": "07971644996",
    "macroName": "llm_botid",
    "macroValue": "0"
  },
  {
    "dnisNo": "07971644996",
    "macroName": "llm_agentid",
    "macroValue": "0"
  },
  {
    "dnisNo": "07971644996",
    "macroName": "llm_extraparam",
    "macroValue": "path-lab"
  },
  {
    "dnisNo": "07971644996",
    "macroName": "llm_iscallbackapi",
    "macroValue": "0"
  },
  {
    "dnisNo": "07971644996",
    "macroName": "llm_callbackapi",
    "macroValue": "https://<APP_BASE_URL>/api/icallmate/callback"
  }
]
```

The app also has a helper endpoint to post these macros:

```bash
curl -X POST http://localhost:3000/api/icallmate/incoming-config \
  -H "Content-Type: application/json" \
  -d '{"dnisNo":"07971644996","dryRun":"true"}'
```

Remove `dryRun` after confirming credentials/network access.

## Event Handling

Telephony to app:

- `connected`: creates/updates an active incoming call
- `start`: validates media format and marks stream started
- `answer`: marks call answered and allows reverse media later
- `media`: counts incoming media packets
- `hangup-call`: closes the call state
- `mark`: logged for diagnostics

App to telephony:

- `mark`: sent after connected/start/answer
- `reverse-media-stop`: sent on hangup
- `reverse-media`: helper exists in code for future AI audio streaming chunks

## What We Need From iCallMate

- Confirm virtual number/DID: `07971644996`
- Confirm public deployed domain for `APP_BASE_URL`
- Test `ukey`, `serviceno`, `ivrtemplateid`, `agentid`, and `botid`
- Whether callback API should be enabled with `llm_iscallbackapi=1` or left as `0`
