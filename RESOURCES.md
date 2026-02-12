# Jules Orchestrator Resources

## API Details
- **Base URL:** `https://jules.googleapis.com/v1alpha`
- **Auth Header:** `X-Goog-Api-Key`
- **Session Create:** `POST /v1alpha/sessions`
- **Session Read:** `GET /v1alpha/sessions/{id}`

## Flow
1. **Create Session:** Send prompt + repo context.
2. **Poll Status:** Check session until completion.
3. **Handle Output:** Apply patches or follow PR URL.
